<?php
// Serveur du jeu de cartes F1 25 : comptes (pilotes du championnat et spectateurs), boosters (gagnés avec les points, aux pronostics et offerts à l'heure), fragments, fabrication, pronostics.
// Contrat complet : API.md. Les données sont dans donnees/etat.json (dossier protégé).
declare(strict_types=1);

require __DIR__ . '/config.php';
date_default_timezone_set('Europe/Paris');

const FICHIER_ETAT = __DIR__ . '/donnees/etat.json';
const CACHE_SAISON = __DIR__ . '/donnees/cache-saison.json';
const CACHE_CATALOGUE = __DIR__ . '/donnees/cache-catalogue.json';
const FICHIER_COPIE = FICHIER_ETAT . '.bak';  // dernière version lisible de l'état, au cas où une écriture serait interrompue
const DUREE_JETON = 180 * 86400;
const TAILLE_FIL = 30;
const DUREE_FERMETURE_AVANCE = 3 * 3600;  // une fermeture « à l'avance » n'est honorée que pendant 3 heures
const PSEUDO_MIN = 3;
const PSEUDO_MAX = 20;
const MOT_DE_PASSE_MIN = 4;
const MOT_DE_PASSE_MAX = 100;
const DUREE_INSCRIPTIONS = 3600;     // les inscriptions récentes sont comptées sur une heure
const INSCRIPTIONS_PAR_IP = 5;       // au plus 5 comptes créés par heure depuis une même connexion
const INSCRIPTIONS_PAR_HEURE = 20;   // et 20 au total, quelle que soit la connexion : un robot ne remplit pas le fichier en quelques minutes
const PSEUDOS_RESERVES = ['admin', 'administrateur', 'moderateur', 'modo', 'spectateur', 'invite', 'anonyme', 'serveur', 'systeme', 'championnat'];

$origine = $_SERVER['HTTP_ORIGIN'] ?? '';
if (in_array($origine, ORIGINES_AUTORISEES, true)) {
    header("Access-Control-Allow-Origin: $origine");
    header('Vary: Origin');
    header('Access-Control-Allow-Headers: Content-Type');
    header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
    header('Access-Control-Max-Age: 86400');
}
if (($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'OPTIONS') {
    http_response_code(204);
    exit;
}
header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');

function repondre(array $donnees, int $code = 200): never
{
    $json = json_encode($donnees, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    if ($json === false) {  // valeur impossible à encoder (ex. un nombre infini venu des données) : mieux vaut une erreur claire qu'une page vide
        $code = 500;
        $json = '{"erreur":"Réponse impossible à fabriquer : données invalides."}';
    }
    http_response_code($code);
    echo $json;
    exit;
}

function erreur(int $code, string $message): never
{
    repondre(['erreur' => $message], $code);
}

/** Télécharge un JSON public (GitHub Pages) avec un cache local ; en cas de panne, garde la dernière version. */
function telecharger(string $url, string $cache, int $duree): array
{
    if (is_file($cache) && time() - filemtime($cache) < $duree) {
        $donnees = json_decode((string) file_get_contents($cache), true);
        if (is_array($donnees)) {
            return $donnees;
        }
    }
    $brut = false;
    $url .= (str_contains($url, '?') ? '&' : '?') . 't=' . time();
    if (function_exists('curl_init')) {
        $ch = curl_init($url);
        curl_setopt_array($ch, [CURLOPT_RETURNTRANSFER => true, CURLOPT_TIMEOUT => 10, CURLOPT_FOLLOWLOCATION => true]);
        $brut = curl_exec($ch);
        if (curl_getinfo($ch, CURLINFO_HTTP_CODE) !== 200) {
            $brut = false;
        }
        curl_close($ch);
    } else {
        $brut = @file_get_contents($url);
    }
    $donnees = is_string($brut) ? json_decode($brut, true) : null;
    if (is_array($donnees)) {
        file_put_contents($cache, $brut, LOCK_EX);
        return $donnees;
    }
    if (is_file($cache)) {
        return json_decode((string) file_get_contents($cache), true);
    }
    erreur(503, 'Impossible de récupérer les données du championnat. Réessaie dans un instant.');
}

function saison(): array
{
    return telecharger(URL_SAISON, CACHE_SAISON, 60);
}

function catalogue(): array
{
    return telecharger(URL_CATALOGUE, CACHE_CATALOGUE, 300);
}

/** Points de chaque joueur, avec les mêmes règles que docs/champ.js (pointsDe). */
function pointsJoueurs(array $saison): array
{
    $points = [];
    foreach ($saison['joueurs'] as $j) {
        $points[$j['id']] = 0;
    }
    foreach ($saison['courses'] as $course) {
        foreach ($course['resultats'] as $r) {
            if (!str_starts_with((string) $r['pilote'], 'j:')) {
                continue;
            }
            $id = substr($r['pilote'], 2);
            if (!array_key_exists($id, $points)) {
                continue;
            }
            if (isset($r['pointsForces']) && $r['pointsForces'] !== '') {
                $forces = (float) $r['pointsForces'];
                $points[$id] += is_finite($forces) ? $forces : 0.0;
            } elseif (($r['statut'] ?? '') === 'fini') {
                $points[$id] += $saison['bareme'][$r['pos'] - 1] ?? 0;
            }
        }
    }
    return $points;
}

function etatVierge(): array
{
    return ['joueurs' => [], 'fil' => []];
}

function joueurVierge(): array
{
    return ['hash' => null, 'jetons' => [], 'echecs' => [], 'ouverts' => 0, 'fragments' => 0, 'cartes' => [], 'fabriquees' => []];
}

/** Décode un état enregistré : null si ce n'est pas un état lisible. */
function decoderEtat(string $brut): ?array
{
    $etat = json_decode($brut, true);
    if (!is_array($etat) || !is_array($etat['joueurs'] ?? null)) {
        return null;
    }
    $etat['fil'] = is_array($etat['fil'] ?? null) ? $etat['fil'] : [];
    return $etat;
}

/** La dernière copie lisible de l'état (etat.json.bak), ou null. */
function lireCopie(): ?array
{
    $brut = is_file(FICHIER_COPIE) ? (string) @file_get_contents(FICHIER_COPIE) : '';
    return $brut === '' ? null : decoderEtat($brut);
}

/**
 * Exécute $action sur l'état, sous verrou exclusif, puis l'enregistre. Un fichier abîmé, ou vide alors qu'il existait (écriture
 * interrompue), n'est jamais remplacé par un état vierge — ce serait perdre tous les comptes : on repart de la dernière copie
 * lisible, sinon on s'arrête avec une erreur. Seul un fichier absent est une installation neuve.
 */
function modifierEtat(callable $action): mixed
{
    $existait = is_file(FICHIER_ETAT);
    $f = fopen(FICHIER_ETAT, 'c+');
    if ($f === false || !flock($f, LOCK_EX)) {
        erreur(500, "Le serveur n'arrive pas à enregistrer les données (droits du dossier donnees ?).");
    }
    try {
        $brut = (string) stream_get_contents($f);
        $avant = $brut;  // ce qu'il faut remettre si l'écriture échoue
        $etat = $brut === '' ? null : decoderEtat($brut);
        $principalLisible = $etat !== null;
        if (!$principalLisible && ($brut !== '' || $existait)) {
            $etat = lireCopie();
            if ($etat === null && $brut !== '') {
                erreur(500, "Le fichier des données est illisible : rien n'a été modifié. Préviens Valentin.");
            }
            $avant = $etat !== null ? (string) json_encode($etat, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES) : '';
        }
        $etat ??= etatVierge();
        $resultat = $action($etat);
        $json = json_encode($etat, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
        if ($json === false) {  // vérifié avant d'effacer le fichier : une valeur impossible à encoder ne doit rien détruire
            erreur(500, "Les données n'ont pas pu être enregistrées (valeur invalide) : rien n'a été modifié.");
        }
        if ($principalLisible) {
            if ($json === $brut) {
                return $resultat;  // rien n'a changé (un refus, une lecture) : ni réécriture ni copie, même sous une rafale de requêtes
            }
            @copy(FICHIER_ETAT, FICHIER_COPIE);  // la dernière version lisible, juste avant de l'écraser
        }
        ftruncate($f, 0);
        rewind($f);
        if (fwrite($f, $json) !== strlen($json) || !fflush($f)) {  // disque plein ? on remet l'ancien contenu au lieu de laisser un fichier tronqué
            ftruncate($f, 0);
            rewind($f);
            fwrite($f, $avant);
            fflush($f);
            erreur(500, "Les données n'ont pas pu être enregistrées (disque plein ?) : rien n'a été modifié.");
        }
    } finally {
        flock($f, LOCK_UN);
        fclose($f);
    }
    return $resultat;
}

/**
 * Lit l'état sans le modifier (verrou partagé : jamais de lecture d'une écriture à moitié faite). Si le fichier est abîmé, ou vide
 * alors qu'il existe, on lit la dernière copie lisible ; absent, l'état est vierge.
 */
function lireEtat(): array
{
    if (!is_file(FICHIER_ETAT)) {
        return etatVierge();
    }
    $f = @fopen(FICHIER_ETAT, 'r');
    if ($f === false) {
        return etatVierge();
    }
    flock($f, LOCK_SH);
    $brut = (string) stream_get_contents($f);
    flock($f, LOCK_UN);
    fclose($f);
    return ($brut === '' ? null : decoderEtat($brut)) ?? lireCopie() ?? etatVierge();
}

function corps(): array
{
    $donnees = json_decode((string) file_get_contents('php://input'), true);
    return is_array($donnees) ? $donnees : [];
}

/** Une valeur du corps de la requête lue comme du texte : tout ce qui n'est pas une chaîne (nombre, tableau, null) devient vide, jamais « Array ». */
function texte(array $entree, string $cle): string
{
    return is_string($entree[$cle] ?? null) ? $entree[$cle] : '';
}

function joueurParNom(array $saison, string $nom): ?array
{
    foreach ($saison['joueurs'] as $j) {
        if (mb_strtolower($j['nom']) === mb_strtolower(trim($nom))) {
            return $j;
        }
    }
    return null;
}

/** Les spectateurs sont des comptes extérieurs au championnat : un pseudo et un mot de passe, une collection, des boosters offerts et des pronostics, sans points. */
function estSpectateur(array $e): bool
{
    return ($e['role'] ?? '') === 'spectateur';
}

/** Réglages des spectateurs (catalogue.json) : [nombre maximum de comptes (0 = inscriptions fermées), boosters offerts à l'inscription]. */
function reglagesSpectateurs(array $catalogue): array
{
    $nombre = fn (string $cle, float $defaut, float $min, float $max): float =>
        is_numeric($catalogue[$cle] ?? null) ? max($min, min($max, (float) $catalogue[$cle])) : $defaut;
    return [(int) $nombre('spectateursMax', 30, 0, 100), (int) $nombre('boostersDepartSpectateur', 1, 0, 100)];
}

/** Forme comparable d'un nom : minuscules, sans accents ni séparateurs (« Marie-Jo », « marie jo » et « MARIEJO » ne font qu'un). */
function cleNom(string $nom): string
{
    $s = strtr(mb_strtolower($nom), [
        'à' => 'a', 'á' => 'a', 'â' => 'a', 'ã' => 'a', 'ä' => 'a', 'å' => 'a', 'æ' => 'ae', 'ç' => 'c',
        'è' => 'e', 'é' => 'e', 'ê' => 'e', 'ë' => 'e', 'ì' => 'i', 'í' => 'i', 'î' => 'i', 'ï' => 'i', 'ñ' => 'n',
        'ò' => 'o', 'ó' => 'o', 'ô' => 'o', 'õ' => 'o', 'ö' => 'o', 'ø' => 'o', 'œ' => 'oe',
        'ù' => 'u', 'ú' => 'u', 'û' => 'u', 'ü' => 'u', 'ý' => 'y', 'ÿ' => 'y', 'ß' => 'ss',
    ]);
    return (string) preg_replace('/[^\p{L}\p{N}]+/u', '', $s);
}

/**
 * Vérifie le pseudo d'un spectateur : [pseudo nettoyé, null] ou [null, message]. Lettres de l'alphabet français (accents compris) et
 * chiffres, avec entre deux mots un espace, un point, un tiret ou une apostrophe : pas de lettres d'un autre alphabet ni de formes
 * proches (ı, ł, ſ…) qui ressembleraient à celles d'un pilote, de sorte que la clé comparée (cleNom) est toujours en a-z et 0-9.
 * Le prénom, le pseudo et les alias des pilotes, les mots réservés et les identifiants « specN » sont réservés.
 */
function pseudoValide(string $brut, array $saison): array
{
    $pseudo = trim((string) preg_replace('/\s+/u', ' ', $brut), ' ');  // les blancs deviennent un seul espace ; trim() sans la liste par défaut, qui retirerait aussi un caractère nul
    $longueur = mb_strlen($pseudo);
    if ($longueur < PSEUDO_MIN || $longueur > PSEUDO_MAX) {
        return [null, 'Le pseudo doit faire entre ' . PSEUDO_MIN . ' et ' . PSEUDO_MAX . ' caractères.'];
    }
    $mot = '[a-zA-Z0-9ÀÁÂÃÄÅÆÇÈÉÊËÌÍÎÏÑÒÓÔÕÖØŒÙÚÛÜÝŸàáâãäåæçèéêëìíîïñòóôõöøœùúûüýÿß]+';  // exactement les lettres que cleNom replie en a-z
    if (!preg_match("/^$mot(?:[ ._'’-]$mot)*$/u", $pseudo)) {
        return [null, "Le pseudo ne peut contenir que des lettres, des chiffres et, entre deux mots, un espace, un point, un tiret ou une apostrophe."];
    }
    $cle = cleNom($pseudo);
    if (mb_strlen($cle) < PSEUDO_MIN) {
        return [null, 'Le pseudo doit contenir au moins ' . PSEUDO_MIN . ' lettres ou chiffres.'];
    }
    $reserves = PSEUDOS_RESERVES;
    foreach ($saison['joueurs'] as $j) {
        foreach (array_merge([$j['nom'] ?? '', $j['id'] ?? ''], (array) ($j['alias'] ?? [])) as $nom) {
            $reserves[] = cleNom((string) $nom);
        }
    }
    if (in_array($cle, $reserves, true) || preg_match('/^spec[0-9]+$/', $cle)) {
        return [null, 'Ce pseudo est réservé : choisis-en un autre.'];
    }
    return [$pseudo, null];
}

/** L'identifiant du spectateur qui porte ce pseudo (sans tenir compte des majuscules, accents et séparateurs), ou null. */
function spectateurParNom(array $etat, string $nom): ?string
{
    $cle = cleNom($nom);
    if ($cle === '') {
        return null;
    }
    foreach ($etat['joueurs'] as $id => $e) {
        if (estSpectateur($e) && cleNom((string) ($e['nom'] ?? '')) === $cle) {  // recalculée à chaque fois : jamais une clé périmée
            return (string) $id;
        }
    }
    return null;
}

/**
 * Empreinte (HMAC) de la connexion du visiteur : son adresse IPv4, ou le préfixe /64 d'une adresse IPv6 (un abonné en a des milliards,
 * changer d'adresse ne coûterait rien), jamais l'adresse elle-même. Sert aux limites d'inscription, oubliées au bout d'une heure.
 */
function empreinteConnexion(): string
{
    $ip = (string) ($_SERVER['REMOTE_ADDR'] ?? '');
    $binaire = @inet_pton($ip);
    if ($binaire !== false && strlen($binaire) === 16) {
        $ip = substr($binaire, 0, 12) === str_repeat("\0", 10) . "\xff\xff"
            ? (string) inet_ntop(substr($binaire, 12))  // IPv4 présentée en IPv6 (::ffff:a.b.c.d)
            : bin2hex(substr($binaire, 0, 8));
    }
    return hash_hmac('sha256', $ip, CLE_ADMIN);
}

/**
 * Ce qui empêche une inscription maintenant : [code, message], ou null. Appelé d'abord en simple lecture (un refus ne coûte ni verrou
 * ni écriture), puis sous verrou au moment d'enregistrer. Du moins cher au plus utile : limites contre les robots, place, pseudo libre.
 */
function obstacleInscription(array $etat, string $pseudo, int $plafond, int $maintenant, string $connexion): ?array
{
    $recentes = array_filter($etat['inscriptions'] ?? [], fn ($i) => (int) ($i['t'] ?? 0) > $maintenant - DUREE_INSCRIPTIONS);
    if (count($recentes) >= INSCRIPTIONS_PAR_HEURE) {
        return [429, 'Trop d\'inscriptions en peu de temps : réessaie dans une heure.'];
    }
    if (count(array_filter($recentes, fn ($i) => ($i['c'] ?? '') === $connexion)) >= INSCRIPTIONS_PAR_IP) {
        return [429, 'Trop de comptes créés depuis cette connexion : réessaie dans une heure.'];
    }
    $cle = cleNom($pseudo);
    $nb = 0;
    $pris = false;
    foreach ($etat['joueurs'] as $e) {
        if (estSpectateur($e)) {
            $nb++;
            $pris = $pris || cleNom((string) ($e['nom'] ?? '')) === $cle;
        }
    }
    if ($nb >= $plafond) {
        return [409, 'Le nombre maximum de spectateurs est atteint pour le moment.'];
    }
    return $pris ? [409, 'Ce pseudo est déjà pris : choisis-en un autre.'] : null;
}

/** Supprime un compte et tout ce qui s'y rapporte : jetons, tirages du fil, paris et gains des pronostics. Son identifiant n'est jamais réutilisé. */
function supprimerCompte(array &$etat, string $id): void
{
    unset($etat['joueurs'][$id]);
    $etat['fil'] = array_values(array_filter($etat['fil'], fn ($x) => ($x['joueur'] ?? '') !== $id));
    foreach (array_keys($etat['pronos']['manches'] ?? []) as $n) {
        unset($etat['pronos']['manches'][$n]['paris'][$id], $etat['pronos']['manches'][$n]['gains'][$id]);
    }
}

/** Retrouve le joueur d'un jeton valide (et purge les jetons expirés). */
function authentifier(array &$etat, string $jeton): string
{
    $empreinte = hash('sha256', $jeton);
    foreach ($etat['joueurs'] as $id => &$j) {
        $j['jetons'] = array_values(array_filter($j['jetons'], fn ($t) => $t['exp'] > time()));
        foreach ($j['jetons'] as $t) {
            if ($jeton !== '' && hash_equals($t['h'], $empreinte)) {
                return $id;
            }
        }
    }
    erreur(401, 'Session expirée : reconnecte-toi.');
}

/** Boosters gagnés = points / pointsParBooster (arrondi en dessous) + boosters bonus donnés dans l'admin + boosters gagnés aux pronostics. */
function boostersGagnes(array $saison, array $catalogue, string $id, int $pronos = 0): int
{
    $ratio = max(1, (float) ($catalogue['pointsParBooster'] ?? 1));
    $bonus = 0;
    foreach ($saison['joueurs'] as $j) {
        if ($j['id'] === $id) {
            $bonus = (int) ($j['boostersBonus'] ?? 0);
        }
    }
    return max(0, (int) floor((pointsJoueurs($saison)[$id] ?? 0) / $ratio) + $bonus + max(0, $pronos));
}

/** Réglages des boosters offerts (catalogue.json) : [intervalle en secondes, stock maximum]. Intervalle 0 = désactivé. */
function reglagesOfferts(array $catalogue): array
{
    $nombre = fn ($valeur, float $defaut): float => is_numeric($valeur) ? (float) $valeur : $defaut;
    $minutes = (int) max(0, min(525600, $nombre($catalogue['minutesParBoosterOffert'] ?? null, 60)));  // au plus 1 an
    $max = (int) max(1, min(1000, $nombre($catalogue['stockMaxBoostersOfferts'] ?? null, 10)));
    return [$minutes * 60, $max];
}

/**
 * Boosters offerts : +1 toutes les $intervalle secondes, jusqu'à $max en stock.
 * $o = ['stock' => n, 'depuis' => t] enregistré pour le joueur ; sans enregistrement, il compte depuis $ancre
 * (mise en service du système). Le stock ne dépasse jamais $max ; quand il est plein le compteur s'arrête,
 * et il repart à l'ouverture d'un booster.
 * Renvoie [stock, depuis] : le prochain booster arrive à depuis + $intervalle.
 */
function calculerOfferts(?array $o, int $maintenant, int $intervalle, int $max, int $ancre): array
{
    $stock = min($max, max(0, (int) ($o['stock'] ?? 0)));
    $depuis = min($maintenant, (int) ($o['depuis'] ?? $ancre));
    if ($intervalle <= 0) {
        return [$stock, $maintenant];
    }
    $arrives = intdiv($maintenant - $depuis, $intervalle);
    if ($stock + $arrives >= $max) {
        return [$max, $maintenant];
    }
    return [$stock + $arrives, $depuis + $arrives * $intervalle];
}

/** Ce que l'API montre des boosters offerts d'un joueur (null : système désactivé et stock vide). */
function vueOfferts(array $e, int $maintenant, int $intervalle, int $max, int $ancre): ?array
{
    [$stock, $depuis] = calculerOfferts($e['offerts'] ?? null, $maintenant, $intervalle, $max, $ancre);
    if ($intervalle <= 0 && $stock === 0) {
        return null;
    }
    return [
        'stock' => $stock, 'max' => $max, 'intervalle' => $intervalle,
        'prochainDans' => $intervalle > 0 && $stock < $max ? max(0, $depuis + $intervalle - $maintenant) : null,
        'ouverts' => (int) ($e['offertsOuverts'] ?? 0),
    ];
}

/**
 * Ce que l'API montre d'un compte (pilote ou spectateur) : boosters, fragments et collection. Seuls les pilotes ont des points
 * ($points non nul) ; ceux d'un spectateur ne viennent que des pronostics.
 */
function vueCompte(array $saison, array $catalogue, string $id, string $nom, array $e, int|float|null $points, int $maintenant, int $intervalle, int $max, int $ancre): array
{
    $pronos = (int) ($e['boostersPronos'] ?? 0);
    $gagnes = boostersGagnes($saison, $catalogue, $id, $pronos);
    $offerts = vueOfferts($e, $maintenant, $intervalle, $max, $ancre);
    $vue = ['id' => $id, 'nom' => $nom, 'compte' => $e['hash'] !== null];
    if ($points !== null) {
        $vue['points'] = $points;
    }
    $vue += [
        'boostersGagnes' => $gagnes, 'boostersPronos' => $pronos, 'boostersOuverts' => $e['ouverts'],
        'boostersDispo' => max(0, $gagnes - $e['ouverts']) + ($offerts['stock'] ?? 0), 'fragments' => $e['fragments'],
        'cartes' => array_keys($e['cartes']), 'nbCartes' => count($e['cartes']),
    ];
    if ($offerts !== null) {
        $vue['offerts'] = $offerts;
    }
    return $vue;
}

/** Faut-il (ré)enregistrer la date de départ et les réglages des boosters offerts ? Vrai au premier appel et après un changement. */
function reglagesOffertsAChanger(array $etat, int $intervalle, int $max): bool
{
    $r = $etat['offertsReglages'] ?? null;
    return !is_array($r) || !isset($etat['offertsDepuis']) || $r['intervalle'] !== $intervalle || $r['max'] !== $max;
}

/**
 * À appeler dans modifierEtat. Au premier appel, note la date de départ des boosters offerts et les réglages en vigueur.
 * Quand l'admin change un réglage (durée, stock maximum, activation), les comptes de tous les joueurs sont d'abord arrêtés
 * à cet instant avec les anciens réglages : le changement ne vaut que pour la suite, rien n'est crédité après coup
 * (réactiver le système ou monter le plafond ne remplit donc pas les stocks d'un coup). Seul un plafond abaissé
 * ramène les stocks plus grands au nouveau plafond.
 */
function appliquerReglagesOfferts(array &$etat, array $saison, int $intervalle, int $max, int $maintenant): void
{
    $ancre = $etat['offertsDepuis'] ??= $maintenant;
    $anciens = $etat['offertsReglages'] ?? null;
    if (is_array($anciens) && ($anciens['intervalle'] !== $intervalle || $anciens['max'] !== $max)) {
        $arreter = function (array &$e) use ($anciens, $maintenant, $ancre): void {
            [$stock, $depuis] = calculerOfferts($e['offerts'] ?? null, $maintenant, (int) $anciens['intervalle'], (int) $anciens['max'], (int) $ancre);
            $e['offerts'] = ['stock' => $stock, 'depuis' => $depuis];
        };
        foreach ($saison['joueurs'] as $j) {
            $e = &$etat['joueurs'][$j['id']];
            $e ??= joueurVierge();
            $arreter($e);
            unset($e);
        }
        foreach ($etat['joueurs'] as &$e) {  // les spectateurs aussi
            if (estSpectateur($e)) {
                $arreter($e);
            }
        }
        unset($e);
    }
    $etat['offertsReglages'] = ['intervalle' => $intervalle, 'max' => $max];
}

function etatModifiable(): bool
{
    return is_file(FICHIER_ETAT) ? is_writable(FICHIER_ETAT) : is_writable(dirname(FICHIER_ETAT));
}

/**
 * Réglages des pronostics (catalogue.json) : [boosters de base « meilleur d'entre nous », boosters de base « ordre d'arrivée »,
 * gain maximum par pari, lissage des cotes]. Le gain d'un pari juste = boosters de base × cote. 0 aux deux premiers = désactivé.
 */
function reglagesPronos(array $catalogue): array
{
    $nombre = fn (string $cle, float $defaut, float $min, float $max): float =>
        is_numeric($catalogue[$cle] ?? null) ? max($min, min($max, (float) $catalogue[$cle])) : $defaut;
    return [
        (int) $nombre('pronosGainMeilleur', 2, 0, 1000),
        (int) $nombre('pronosGainOrdre', 4, 0, 1000),
        (int) $nombre('pronosGainMax', 60, 1, 100000),
        $nombre('pronosLissage', 15, 1, 100000),
    ];
}

function pronosActifs(array $catalogue): bool
{
    [$meilleur, $ordre] = reglagesPronos($catalogue);
    return $meilleur > 0 || $ordre > 0;
}

/** Forces des joueurs pour les cotes : points au championnat + lissage (avec peu de GP joués, les cotes restent proches). */
function forcesPronos(array $saison, float $lissage): array
{
    $points = pointsJoueurs($saison);
    $forces = [];
    foreach ($saison['joueurs'] as $j) {
        if (!empty($j['parti'])) {  // un joueur parti du championnat ne participe plus aux pronostics
            continue;
        }
        $forces[$j['id']] = max(0.0, (float) ($points[$j['id']] ?? 0)) + $lissage;
    }
    return $forces;
}

/** Arrondi au dixième, moitiés vers le haut. Calcul identique dans cartes.js : on évite round(), qui n'arrondit pas pareil d'un langage à l'autre. */
function arrondiDixieme(float $x): float
{
    return floor($x * 10 + 0.5 + 1e-9) / 10;
}

/** Cote d'un événement de probabilité $p : 1/p arrondi au dixième, entre 1,1 et le plafond (gain maximum ÷ boosters de base). */
function cotePronos(float $p, int $base, int $max): float
{
    $plafond = $base > 0 ? max(1.1, $max / $base) : 1.1;
    return arrondiDixieme(min($plafond, max(1.1, $p > 0 ? 1 / $p : $plafond)));
}

/** Cote du « meilleur d'entre nous » pour chaque joueur. */
function cotesMeilleur(array $forces, int $base, int $max): array
{
    $total = array_sum($forces);
    $cotes = [];
    foreach ($forces as $id => $force) {
        $cotes[$id] = cotePronos($force / $total, $base, $max);
    }
    return $cotes;
}

/** Cote d'un ordre d'arrivée (modèle de Plackett-Luce : chaque place est attribuée au hasard selon les forces restantes). */
function coteOrdre(array $forces, array $ordre, int $base, int $max): float
{
    $reste = 0.0;
    foreach ($ordre as $id) {
        $reste += $forces[$id];
    }
    $p = 1.0;
    foreach ($ordre as $id) {
        $p *= $forces[$id] / $reste;
        $reste -= $forces[$id];
    }
    return cotePronos($p, $base, $max);
}

/** Boosters gagnés par un pari juste. */
function gainPronos(int $base, float $cote, int $max): int
{
    return $base > 0 ? min($max, max(1, (int) floor($base * $cote + 0.5 + 1e-9))) : 0;
}

function courseDeManche(array $saison, int $manche): ?array
{
    foreach ($saison['courses'] as $c) {
        if (isset($c['manche']) && (int) $c['manche'] === $manche) {
            return $c;
        }
    }
    return null;
}

/** Prochain GP du calendrier à pronostiquer : le premier sans course enregistrée et dont les pronostics ne sont pas déjà réglés. */
function prochaineManchePronos(array $saison, array $manches): ?array
{
    $courues = [];
    foreach ($saison['courses'] as $c) {
        if (isset($c['manche'])) {
            $courues[(int) $c['manche']] = true;
        }
    }
    $calendrier = $saison['calendrier'];
    usort($calendrier, fn ($a, $b) => $a['manche'] <=> $b['manche']);
    foreach ($calendrier as $gp) {
        $n = (int) $gp['manche'];
        if (!isset($courues[$n]) && ($manches[$n]['statut'] ?? '') !== 'regle') {
            return $gp;
        }
    }
    return null;
}

/**
 * Règle les pronostics d'une manche d'après la course enregistrée et crédite les gains. À n'appeler qu'une fois par manche
 * (statut « regle » ensuite), sous verrou : le crédit ne peut donc pas être fait deux fois.
 */
function reglerManchePronos(array &$etat, array &$m, array $course, array $saison, int $maintenant): void
{
    $place = [];  // id => place d'arrivée, pour les joueurs du pronostic qui ont couru
    foreach ($course['resultats'] as $r) {
        $id = substr((string) ($r['pilote'] ?? ''), 2);
        if (str_starts_with((string) ($r['pilote'] ?? ''), 'j:') && isset($m['forces'][$id]) && ($r['statut'] ?? '') !== 'absent' && (int) ($r['pos'] ?? 0) >= 1) {
            $place[$id] = (int) $r['pos'];
        }
    }
    asort($place);
    $classement = array_keys($place);
    $absents = array_values(array_diff(array_keys($m['forces']), $classement));
    $annulee = count($classement) < 2;
    $bases = $m['bases'];
    $gains = [];
    if (!$annulee) {
        foreach ($m['paris'] as $id => $pari) {
            $g = ['meilleur' => 0, 'ordre' => 0];
            if (($pari['meilleur'] ?? null) === $classement[0]) {
                $g['meilleur'] = gainPronos($bases['meilleur'], (float) ($m['cotes']['meilleur'][$classement[0]] ?? 1.1), $bases['max']);
            }
            if (isset($pari['ordre']) && $bases['ordre'] > 0) {
                // un joueur absent est simplement retiré de l'ordre prédit
                $filtre = array_values(array_filter($pari['ordre'], fn ($x) => in_array($x, $classement, true)));
                if ($filtre === $classement) {
                    $g['ordre'] = gainPronos($bases['ordre'], coteOrdre($m['forces'], $filtre, $bases['ordre'], $bases['max']), $bases['max']);
                }
            }
            $gains[$id] = $g;
            $total = $g['meilleur'] + $g['ordre'];
            if ($total > 0 && (isset($etat['joueurs'][$id]) || isset($m['forces'][$id]))) {  // un compte supprimé entre-temps ne reçoit rien (et n'est pas recréé)
                $j = &$etat['joueurs'][$id];
                $j ??= joueurVierge();
                $j['boostersPronos'] = (int) ($j['boostersPronos'] ?? 0) + $total;
                unset($j);
            }
        }
    }
    $m['resultat'] = ['course' => (string) ($course['id'] ?? ''), 'classement' => $classement, 'absents' => $absents, 'annulee' => $annulee];
    $m['gains'] = $gains;
    $m['statut'] = 'regle';
    $m['regleLe'] = $maintenant;
}

/**
 * Règle les manches dont la course est enregistrée, puis ouvre les pronostics du prochain GP (cotes figées à l'ouverture).
 * À appeler sous verrou (modifierEtat) ; sans effet si rien n'est à faire. Renvoie true si l'état a changé.
 * Une course « à vérifier » (joueur non reconnu…) n'est pas réglée : le classement serait faux et le crédit définitif.
 * Elle l'est dès que l'admin l'a corrigée (la saison est relue à chaque appel).
 */
function synchroniserPronos(array &$etat, array $saison, array $catalogue, int $maintenant): bool
{
    $change = false;
    $etat['pronos']['manches'] ??= [];
    $manches = &$etat['pronos']['manches'];
    $enCours = false;  // un GP non réglé dont la course n'est pas encore enregistrée
    foreach ($manches as $n => &$m) {
        if (($m['statut'] ?? '') === 'regle') {
            continue;
        }
        $course = courseDeManche($saison, (int) $n);
        if ($course === null) {
            $enCours = true;
        } elseif (empty($course['aVerifier'])) {
            reglerManchePronos($etat, $m, $course, $saison, $maintenant);
            $change = true;
        } elseif (($m['statut'] ?? '') === 'ouvert') {
            // course enregistrée mais à vérifier : le résultat est connu, on ne parie plus
            $m['statut'] = 'ferme';
            $m['fermeLe'] = $maintenant;
            $change = true;
        }
    }
    unset($m);
    foreach (($etat['pronos']['fermesAvance'] ?? []) as $cle => $depuis) {  // fermetures « à l'avance » restées sans suite
        if ($maintenant - (int) $depuis >= DUREE_FERMETURE_AVANCE) {
            unset($etat['pronos']['fermesAvance'][$cle]);
        }
    }
    if (!$enCours && pronosActifs($catalogue)) {
        $gp = prochaineManchePronos($saison, $manches);
        if ($gp !== null && !isset($manches[(int) $gp['manche']])) {
            $n = (int) $gp['manche'];
            [$base, $baseOrdre, $max, $lissage] = reglagesPronos($catalogue);
            $forces = forcesPronos($saison, $lissage);
            $fermeeAvance = isset($etat['pronos']['fermesAvance'][$n]) && $maintenant - (int) $etat['pronos']['fermesAvance'][$n] < DUREE_FERMETURE_AVANCE;
            unset($etat['pronos']['fermesAvance'][$n]);
            $manches[$n] = [
                'statut' => $fermeeAvance ? 'ferme' : 'ouvert',
                'gp' => (string) ($gp['gp'] ?? ''), 'ouvertLe' => $maintenant,
                'bases' => ['meilleur' => $base, 'ordre' => $baseOrdre, 'max' => $max],
                'forces' => $forces, 'cotes' => ['meilleur' => cotesMeilleur($forces, $base, $max)], 'paris' => [],
            ];
            $change = true;
        }
    }
    unset($manches);
    return $change;
}

/**
 * Le GP dont les pronostics sont en cours : le premier non réglé dont la course n'est pas encore enregistrée (ouvert, ou fermé
 * le temps de la course) ; à défaut, un GP dont le résultat attend sa vérification. [numéro, données] ou null.
 */
function mancheCourantePronos(array $etat, array $saison): ?array
{
    $enAttente = null;
    foreach (($etat['pronos']['manches'] ?? []) as $n => $m) {
        if (($m['statut'] ?? '') === 'regle') {
            continue;
        }
        if (courseDeManche($saison, (int) $n) === null) {
            return [(int) $n, $m];
        }
        $enAttente ??= [(int) $n, $m];
    }
    return $enAttente;
}

/**
 * Un pari enregistré avec ses cotes et les boosters en jeu, tels que le règlement les calculerait si tous les joueurs courent.
 * Les cotes sont celles figées à l'ouverture du GP.
 */
function detailPari(array $m, array $pari): array
{
    $b = $m['bases'];
    $meilleur = $pari['meilleur'] ?? null;
    $ordre = $pari['ordre'] ?? null;
    $coteMeilleur = $meilleur !== null ? (float) ($m['cotes']['meilleur'][$meilleur] ?? 1.1) : null;
    $coteOrdre = $ordre !== null ? coteOrdre($m['forces'], $ordre, $b['ordre'], $b['max']) : null;
    return [
        'meilleur' => $meilleur, 'ordre' => $ordre,
        'cotes' => ['meilleur' => $coteMeilleur, 'ordre' => $coteOrdre],
        'gains' => [
            'meilleur' => $coteMeilleur !== null ? gainPronos($b['meilleur'], $coteMeilleur, $b['max']) : 0,
            'ordre' => $coteOrdre !== null ? gainPronos($b['ordre'], $coteOrdre, $b['max']) : 0,
        ],
    ];
}

/** Ce que l'API montre des pronostics : le GP en cours (paris des autres cachés tant que c'est ouvert), les derniers résultats, le classement. */
function vuePronos(array $etat, array $saison, array $catalogue): array
{
    $manches = $etat['pronos']['manches'] ?? [];
    $courante = mancheCourantePronos($etat, $saison);
    $historique = [];
    $enAttente = [];  // courses enregistrées mais à vérifier par l'admin : les gains arriveront après sa validation
    $classement = [];
    foreach ($saison['joueurs'] as $j) {
        $classement[$j['id']] = ['joueur' => $j['id'], 'boosters' => 0, 'bonsMeilleur' => 0, 'bonsOrdre' => 0, 'paris' => 0];
    }
    foreach ($etat['joueurs'] as $id => $e) {  // les spectateurs jouent aussi : ils n'apparaissent au classement qu'après leur premier pari réglé
        if (estSpectateur($e)) {
            $classement[(string) $id] = ['joueur' => (string) $id, 'boosters' => 0, 'bonsMeilleur' => 0, 'bonsOrdre' => 0, 'paris' => 0, 'spectateur' => true];
        }
    }
    foreach ($manches as $n => $m) {
        if (($m['statut'] ?? '') !== 'regle') {
            if (courseDeManche($saison, (int) $n) !== null) {
                $enAttente[] = ['manche' => (int) $n, 'gp' => (string) ($m['gp'] ?? '')];
            }
            continue;
        }
        $historique[] = ['manche' => (int) $n, 'gp' => (string) ($m['gp'] ?? ''), 'resultat' => $m['resultat'] ?? null,
                         'gains' => (object) ($m['gains'] ?? []),
                         'paris' => (object) array_map(fn ($p) => array_intersect_key($p, ['meilleur' => 1, 'ordre' => 1]), $m['paris'] ?? [])];
        if (!empty($m['resultat']['annulee'])) {
            continue;  // GP annulé : ni paris comptés, ni gains
        }
        foreach (($m['paris'] ?? []) as $id => $pari) {
            if (!isset($classement[$id])) {
                continue;
            }
            $g = $m['gains'][$id] ?? ['meilleur' => 0, 'ordre' => 0];
            $classement[$id]['paris']++;
            $classement[$id]['boosters'] += $g['meilleur'] + $g['ordre'];
            $classement[$id]['bonsMeilleur'] += $g['meilleur'] > 0 ? 1 : 0;
            $classement[$id]['bonsOrdre'] += $g['ordre'] > 0 ? 1 : 0;
        }
    }
    $actif = pronosActifs($catalogue);
    usort($historique, fn ($a, $b) => $b['manche'] <=> $a['manche']);
    $classement = array_values(array_filter($classement, fn ($c) => empty($c['spectateur']) || $c['paris'] > 0));
    usort($classement, fn ($a, $b) => [$b['boosters'], $b['bonsMeilleur'] + $b['bonsOrdre']] <=> [$a['boosters'], $a['bonsMeilleur'] + $a['bonsOrdre']]);
    $vue = ['actif' => $actif, 'manche' => null, 'gp' => null, 'statut' => null, 'bases' => null, 'forces' => null, 'cotes' => null,
            'aParie' => [], 'enAttente' => $enAttente, 'historique' => array_slice($historique, 0, 6), 'classement' => $classement];
    if ($courante !== null) {
        [$n, $m] = $courante;
        $vue['manche'] = $n;
        $vue['gp'] = $m['gp'] ?? '';
        $vue['statut'] = $m['statut'];
        $vue['bases'] = $m['bases'];
        $vue['forces'] = $m['forces'];
        $vue['cotes'] = $m['cotes'];
        foreach ($saison['joueurs'] as $j) {
            $vue['aParie'][$j['id']] = isset($m['paris'][$j['id']]);
        }
        foreach ($etat['joueurs'] as $id => $e) {
            if (estSpectateur($e)) {
                $vue['aParie'][(string) $id] = isset($m['paris'][$id]);
            }
        }
        if ($m['statut'] !== 'ouvert') {
            $vue['paris'] = (object) array_map(fn ($p) => array_intersect_key($p, ['meilleur' => 1, 'ordre' => 1]), $m['paris']);
        }
    }
    return $vue;
}

function indexer(array $catalogue): array
{
    $parRarete = [];
    $cartes = [];
    foreach ($catalogue['cartes'] as $c) {
        $parRarete[$c['rarete']][] = $c['id'];
        $cartes[$c['id']] = $c;
    }
    $raretes = [];
    foreach ($catalogue['raretes'] as $r) {
        $raretes[$r['id']] = $r;
    }
    return [$cartes, $parRarete, $raretes];
}

/** Tire une carte : d'abord la rareté selon les poids, puis une carte au hasard de cette rareté. */
function tirer(array $catalogue, array $parRarete, bool $derniere): string
{
    $candidates = [];
    foreach ($catalogue['raretes'] as $r) {  // de la plus rare à la plus courante
        if (!empty($parRarete[$r['id']])) {
            $candidates[] = $r;
        }
        if ($derniere && $r['id'] === $catalogue['derniereCarteMin']) {
            break;
        }
    }
    $total = (int) array_sum(array_column($candidates, 'poids'));
    if ($total < 1) {
        if ($derniere) {  // aucune rareté permise n'a de poids (ex. dernière carte « au minimum Mythique ») : on ignore ce minimum
            return tirer($catalogue, $parRarete, false);
        }
        $liste = $parRarete[end($candidates)['id']];  // catalogue sans aucun poids : la rareté la plus basse
        return $liste[random_int(0, count($liste) - 1)];
    }
    $x = random_int(1, $total);
    foreach ($candidates as $r) {
        $x -= $r['poids'];
        if ($x <= 0) {
            $liste = $parRarete[$r['id']];
            return $liste[random_int(0, count($liste) - 1)];
        }
    }
    $liste = $parRarete[end($candidates)['id']];
    return $liste[random_int(0, count($liste) - 1)];
}

/** Chance (de 0 à 1) qu'un booster contienne une carte Mythique (réglage chanceMythiqueParBooster, en % ; 1 % par défaut). */
function chanceMythiqueParBooster(array $catalogue): float
{
    $pourcent = is_numeric($catalogue['chanceMythiqueParBooster'] ?? null) ? (float) $catalogue['chanceMythiqueParBooster'] : 1.0;
    return max(0.0, min(100.0, $pourcent)) / 100;
}

/** Ce booster contient-il une Mythique ? Un seul tirage, avec exactement la chance réglée : jamais plus d'une par booster. */
function boosterAvecMythique(float $chance, array $parRarete): bool
{
    return $chance > 0 && !empty($parRarete['mythique']) && random_int(1, 1000000) <= (int) round($chance * 1000000);
}

/** Une carte Mythique au hasard (les cartes des potes) : une que le joueur n'a pas encore passe avant un doublon. */
function tirerMythique(array $parRarete, array $possedees): string
{
    $liste = $parRarete['mythique'];
    $nouvelles = array_values(array_filter($liste, fn ($id) => !isset($possedees[$id])));
    $choix = $nouvelles ?: $liste;
    return $choix[random_int(0, count($choix) - 1)];
}

function ajouterAuFil(array &$etat, string $joueur, string $carte, bool $fabriquee): void
{
    array_unshift($etat['fil'], ['joueur' => $joueur, 'carte' => $carte, 'date' => date('c'), 'fabriquee' => $fabriquee]);
    $etat['fil'] = array_slice($etat['fil'], 0, TAILLE_FIL);
}

const RARETES_DU_FIL = ['mythique', 'icone', 'legendaire', 'epique'];

$action = $_GET['action'] ?? '';
$methode = $_SERVER['REQUEST_METHOD'] ?? 'GET';

if ($action === 'etat' && $methode === 'GET') {
    $saison = saison();
    $catalogue = catalogue();
    $etat = lireEtat();
    $maintenant = time();
    [$intervalle, $maxOffert] = reglagesOfferts($catalogue);
    $copie = $etat;  // essai à blanc : faut-il régler une course arrivée ou ouvrir le prochain GP aux pronostics ?
    $pronosAFaire = synchroniserPronos($copie, $saison, $catalogue, $maintenant);
    unset($copie);
    if ((reglagesOffertsAChanger($etat, $intervalle, $maxOffert) || $pronosAFaire) && etatModifiable()) {
        // première fois, ou réglages changés dans l'admin (voir appliquerReglagesOfferts), ou pronostics à régler / ouvrir
        $etat = modifierEtat(function (array &$e) use ($saison, $catalogue, $intervalle, $maxOffert, $maintenant) {
            appliquerReglagesOfferts($e, $saison, $intervalle, $maxOffert, $maintenant);
            synchroniserPronos($e, $saison, $catalogue, $maintenant);
            return $e;
        });
    }
    $ancre = (int) ($etat['offertsDepuis'] ?? $maintenant);
    $points = pointsJoueurs($saison);
    $joueurs = [];
    foreach ($saison['joueurs'] as $j) {
        $e = $etat['joueurs'][$j['id']] ?? joueurVierge();
        $vue = vueCompte($saison, $catalogue, $j['id'], $j['nom'], $e, $points[$j['id']], $maintenant, $intervalle, $maxOffert, $ancre);
        if (!empty($j['parti'])) {
            $vue['parti'] = true;
        }
        $joueurs[] = $vue;
    }
    // Les spectateurs sont à part : « joueurs » ne contient que les pilotes du championnat (une page plus ancienne n'y voit rien de nouveau)
    $spectateurs = [];
    foreach ($etat['joueurs'] as $id => $e) {
        if (estSpectateur($e)) {
            $s = vueCompte($saison, $catalogue, (string) $id, (string) ($e['nom'] ?? $id), $e, null, $maintenant, $intervalle, $maxOffert, $ancre);
            $s['role'] = 'spectateur';
            $s['cree'] = (int) ($e['cree'] ?? 0);
            $spectateurs[] = $s;
        }
    }
    [$plafond] = reglagesSpectateurs($catalogue);
    $restantes = max(0, $plafond - count($spectateurs));
    repondre(['joueurs' => $joueurs, 'spectateurs' => $spectateurs, 'inscriptions' => ['ouvertes' => $restantes > 0, 'max' => $plafond, 'restantes' => $restantes],
              'fil' => $etat['fil'], 'totalCartes' => count($catalogue['cartes']), 'pronos' => vuePronos($etat, $saison, $catalogue)]);
}

if ($methode !== 'POST') {
    erreur(405, 'Action inconnue.');
}
if ($origine !== '' && !in_array($origine, ORIGINES_AUTORISEES, true)) {
    // Un navigateur envoie toujours l'origine de la page qui appelle : celle d'un autre site n'a pas à créer de comptes ni à parier
    // (le CORS n'empêche que de lire la réponse, pas d'écrire). Sans origine (enregistreur, tests, curl) : accepté.
    erreur(403, 'Origine non autorisée.');
}
$entree = corps();

if ($action === 'connexion') {
    // Un pilote du championnat (son prénom) ou un spectateur (son pseudo) : le même formulaire, le même mot de passe.
    // La page dit sur quel onglet on se connecte (`role` : « pilote » ou « spectateur ») : un nom tapé dans l'onglet Spectateur ne touche
    // jamais le compte d'un pilote (ni son premier mot de passe), et inversement. Sans `role` (enregistreur, ancienne page), on cherche dans les deux.
    $saison = saison();
    $nom = texte($entree, 'nom');
    $motDePasse = texte($entree, 'motDePasse');
    $role = texte($entree, 'role');
    $trouver = function (array $etat) use ($saison, $nom, $role): ?array {  // [identifiant, nom affiché] ou null
        $joueur = $role === 'spectateur' ? null : joueurParNom($saison, $nom);
        if ($joueur !== null) {
            return [(string) $joueur['id'], (string) $joueur['nom']];
        }
        $id = $role === 'pilote' ? null : spectateurParNom($etat, $nom);
        return $id === null ? null : [$id, (string) ($etat['joueurs'][$id]['nom'] ?? $id)];
    };
    if ($trouver(lireEtat()) === null) {
        erreur(404, 'Compte inconnu : vérifie ton prénom (pilote) ou ton pseudo (spectateur).');  // rien n'est écrit pour un nom inconnu
    }
    $resultat = modifierEtat(function (array &$etat) use ($trouver, $motDePasse) {
        $trouve = $trouver($etat);
        if ($trouve === null) {
            return [404, 'Compte inconnu : vérifie ton prénom (pilote) ou ton pseudo (spectateur).'];
        }
        [$id, $affiche] = $trouve;
        $j = &$etat['joueurs'][$id];
        $j ??= joueurVierge();
        $j['echecs'] = array_values(array_filter($j['echecs'], fn ($t) => $t > time() - 600));
        if (count($j['echecs']) >= 10) {
            return [429, 'Trop d\'essais : réessaie dans 10 minutes.'];
        }
        $premiere = $j['hash'] === null;  // un compte dont l'admin a effacé le mot de passe : celui-ci devient le nouveau
        if ($premiere) {
            if (mb_strlen($motDePasse) < MOT_DE_PASSE_MIN) {
                return [400, 'Choisis un mot de passe d\'au moins ' . MOT_DE_PASSE_MIN . ' caractères.'];
            }
            if (mb_strlen($motDePasse) > MOT_DE_PASSE_MAX) {
                return [400, 'Mot de passe trop long (' . MOT_DE_PASSE_MAX . ' caractères au maximum).'];
            }
            $j['hash'] = password_hash($motDePasse, PASSWORD_DEFAULT);
        } elseif (!password_verify($motDePasse, $j['hash'])) {
            $j['echecs'][] = time();
            return [401, 'Mot de passe incorrect.'];
        }
        $jeton = bin2hex(random_bytes(24));
        $j['jetons'][] = ['h' => hash('sha256', $jeton), 'exp' => time() + DUREE_JETON];
        $j['jetons'] = array_slice($j['jetons'], -5);
        $j['echecs'] = [];
        return ['jeton' => $jeton, 'joueur' => $id, 'nom' => $affiche, 'role' => estSpectateur($j) ? 'spectateur' : 'pilote', 'premiereConnexion' => $premiere];
    });
    if (isset($resultat[0]) && is_int($resultat[0])) {
        if ($resultat[0] === 401) {
            usleep(800000);
        }
        erreur($resultat[0], $resultat[1]);
    }
    repondre($resultat);
}

if ($action === 'inscription') {
    // Un spectateur crée son compte : un pseudo et un mot de passe. Il ne joue pas au championnat (aucun point) mais a sa collection,
    // ses boosters offerts à l'heure et ses pronostics. Garde-fous : plafond de comptes (catalogue), limites par connexion et au total.
    $saison = saison();
    $catalogue = catalogue();
    [$plafond, $depart] = reglagesSpectateurs($catalogue);
    $depart = min($depart, reglagesOfferts($catalogue)[1]);  // jamais plus que le stock maximum : l'excédent disparaîtrait en silence
    if ($plafond <= 0) {
        erreur(403, 'Les inscriptions de spectateurs sont fermées pour le moment.');
    }
    [$pseudo, $probleme] = pseudoValide(texte($entree, 'nom'), $saison);
    if ($pseudo === null) {
        erreur(400, $probleme);
    }
    $motDePasse = texte($entree, 'motDePasse');
    if (mb_strlen($motDePasse) < MOT_DE_PASSE_MIN) {
        erreur(400, 'Choisis un mot de passe d\'au moins ' . MOT_DE_PASSE_MIN . ' caractères.');
    }
    if (mb_strlen($motDePasse) > MOT_DE_PASSE_MAX) {
        erreur(400, 'Mot de passe trop long (' . MOT_DE_PASSE_MAX . ' caractères au maximum).');
    }
    $maintenant = time();
    $connexion = empreinteConnexion();
    $obstacle = obstacleInscription(lireEtat(), $pseudo, $plafond, $maintenant, $connexion);  // un refus évident : ni verrou, ni écriture, ni calcul du mot de passe
    if ($obstacle !== null) {
        erreur($obstacle[0], $obstacle[1]);
    }
    $empreinteMdp = password_hash($motDePasse, PASSWORD_DEFAULT);  // lent (≈ 70 ms) : fait avant le verrou
    $resultat = modifierEtat(function (array &$etat) use ($pseudo, $empreinteMdp, $saison, $plafond, $depart, $maintenant, $connexion) {
        $obstacle = obstacleInscription($etat, $pseudo, $plafond, $maintenant, $connexion);  // refait sous verrou : un autre visiteur a pu passer entre-temps
        if ($obstacle !== null) {
            return $obstacle;
        }
        $etat['inscriptions'] = array_values(array_filter($etat['inscriptions'] ?? [], fn ($i) => (int) ($i['t'] ?? 0) > $maintenant - DUREE_INSCRIPTIONS));
        $n = (int) ($etat['prochainSpectateur'] ?? 0);
        do {  // un numéro jamais utilisé, jamais réutilisé après une suppression
            $n++;
            $id = 'spec' . $n;
            $pris = isset($etat['joueurs'][$id]) || array_filter($saison['joueurs'], fn ($j) => (string) $j['id'] === $id);
        } while ($pris);
        $etat['prochainSpectateur'] = $n;
        $jeton = bin2hex(random_bytes(24));
        $etat['joueurs'][$id] = array_merge(joueurVierge(), [
            'role' => 'spectateur', 'nom' => $pseudo, 'cree' => $maintenant,
            'hash' => $empreinteMdp,
            'jetons' => [['h' => hash('sha256', $jeton), 'exp' => $maintenant + DUREE_JETON]],
            'offerts' => ['stock' => $depart, 'depuis' => $maintenant],  // son compteur démarre à l'inscription
        ]);
        $etat['inscriptions'][] = ['t' => $maintenant, 'c' => $connexion];
        return ['jeton' => $jeton, 'joueur' => $id, 'nom' => $pseudo, 'role' => 'spectateur', 'premiereConnexion' => true];
    });
    if (isset($resultat[0]) && is_int($resultat[0])) {
        erreur($resultat[0], $resultat[1]);
    }
    repondre($resultat);
}

if ($action === 'ouvrir') {
    $saison = saison();
    $catalogue = catalogue();
    [$cartes, $parRarete, $raretes] = indexer($catalogue);
    [$intervalle, $maxOffert] = reglagesOfferts($catalogue);
    $chanceMythique = chanceMythiqueParBooster($catalogue);
    $maintenant = time();
    $nombre = max(1, min(100, (int) ($entree['nombre'] ?? 1)));
    $resultat = modifierEtat(function (array &$etat) use ($entree, $saison, $catalogue, $cartes, $parRarete, $raretes, $nombre, $intervalle, $maxOffert, $maintenant, $chanceMythique) {
        $id = authentifier($etat, texte($entree, 'jeton'));
        appliquerReglagesOfferts($etat, $saison, $intervalle, $maxOffert, $maintenant);
        synchroniserPronos($etat, $saison, $catalogue, $maintenant);  // les gains d'un GP tout juste réglé comptent tout de suite
        $ancre = (int) $etat['offertsDepuis'];
        $j = &$etat['joueurs'][$id];
        [$offerts, $depuis] = calculerOfferts($j['offerts'] ?? null, $maintenant, $intervalle, $maxOffert, $ancre);
        $dispoPoints = max(0, boostersGagnes($saison, $catalogue, $id, (int) ($j['boostersPronos'] ?? 0)) - $j['ouverts']);
        if ($dispoPoints + $offerts <= 0) {
            return ['aucun' => $intervalle > 0 ? max(0, $depuis + $intervalle - $maintenant) : null, 'spectateur' => estSpectateur($j)];
        }
        $aOuvrir = min($nombre, $dispoPoints + $offerts);
        $boosters = [];
        for ($b = 0; $b < $aOuvrir; $b++) {
            $booster = [];
            // Au plus une Mythique par booster : un seul tirage (la chance réglée), puis une place au hasard dans le booster
            $placeMythique = boosterAvecMythique($chanceMythique, $parRarete) ? random_int(0, max(0, (int) $catalogue['cartesParBooster'] - 1)) : -1;
            for ($k = 0; $k < $catalogue['cartesParBooster']; $k++) {
                $carte = $k === $placeMythique
                    ? tirerMythique($parRarete, $j['cartes'])
                    : tirer($catalogue, $parRarete, $k === $catalogue['cartesParBooster'] - 1);
                $rarete = $cartes[$carte]['rarete'];
                if (isset($j['cartes'][$carte])) {
                    $gain = $raretes[$rarete]['fragments'];
                    $j['fragments'] += $gain;
                    $booster[] = ['carte' => $carte, 'nouvelle' => false, 'fragments' => $gain];
                } else {
                    $j['cartes'][$carte] = 1;
                    $booster[] = ['carte' => $carte, 'nouvelle' => true, 'fragments' => 0];
                    if (in_array($rarete, RARETES_DU_FIL, true)) {
                        ajouterAuFil($etat, $id, $carte, false);
                    }
                }
            }
            // Les boosters offerts passent en premier : leur stock est plafonné, ceux gagnés avec les points ne disparaissent pas
            if ($offerts > 0) {
                $offerts--;
                $j['offertsOuverts'] = ($j['offertsOuverts'] ?? 0) + 1;
            } else {
                $j['ouverts']++;
            }
            $boosters[] = $booster;
        }
        $j['offerts'] = ['stock' => $offerts, 'depuis' => $depuis];
        $reponse = ['boosters' => $boosters, 'fragments' => $j['fragments'], 'boostersOuverts' => $j['ouverts'],
                    'boostersDispo' => max(0, boostersGagnes($saison, $catalogue, $id, (int) ($j['boostersPronos'] ?? 0)) - $j['ouverts']) + $offerts];
        $vue = vueOfferts($j, $maintenant, $intervalle, $maxOffert, $ancre);
        if ($vue !== null) {
            $reponse['offerts'] = $vue;
        }
        return $reponse;
    });
    if (array_key_exists('aucun', $resultat)) {
        $attente = $resultat['aucun'];
        $autre = $resultat['spectateur'] ? 'gagne-en aux pronostics' : 'marque des points au prochain GP';  // un spectateur ne marque pas de points
        erreur(409, $attente === null
            ? "Aucun booster disponible : $autre !"
            : 'Aucun booster disponible : le prochain booster offert arrive dans ' . max(1, intdiv($attente + 59, 60)) . " min, ou $autre !");
    }
    repondre($resultat);
}

if ($action === 'fabriquer') {
    $catalogue = catalogue();
    [$cartes, , $raretes] = indexer($catalogue);
    $carte = texte($entree, 'carte');
    if (!isset($cartes[$carte])) {
        erreur(404, 'Carte inconnue.');
    }
    if ($cartes[$carte]['rarete'] === 'mythique') {
        erreur(409, 'Les cartes Mythiques ne se fabriquent pas : elles se trouvent uniquement dans les boosters.');
    }
    $cout = (int) ($cartes[$carte]['cout'] ?? $raretes[$cartes[$carte]['rarete']]['cout']);
    $resultat = modifierEtat(function (array &$etat) use ($entree, $carte, $cout, $cartes) {
        $id = authentifier($etat, texte($entree, 'jeton'));
        $j = &$etat['joueurs'][$id];
        if (isset($j['cartes'][$carte])) {
            return 'Tu as déjà cette carte.';
        }
        if ($j['fragments'] < $cout) {
            return "Il te faut $cout fragments (tu en as {$j['fragments']}).";
        }
        $j['fragments'] -= $cout;
        $j['cartes'][$carte] = 1;
        $j['fabriquees'][] = $carte;
        if (in_array($cartes[$carte]['rarete'], RARETES_DU_FIL, true)) {
            ajouterAuFil($etat, $id, $carte, true);
        }
        return ['carte' => $carte, 'fragments' => $j['fragments']];
    });
    if (is_string($resultat)) {
        erreur(409, $resultat);
    }
    repondre($resultat);
}

if ($action === 'pronostiquer' || $action === 'monPronostic') {
    $saison = saison();
    $catalogue = catalogue();
    $maintenant = time();
    // La page indique le GP sur lequel le joueur parie : si, entre-temps, il a été réglé et le suivant ouvert, on refuse
    // (le pari irait sinon sur un GP que le joueur n'a pas sous les yeux)
    $voulu = isset($entree['manche']) && is_numeric($entree['manche']) ? (int) $entree['manche'] : null;
    $resultat = modifierEtat(function (array &$etat) use ($action, $entree, $saison, $catalogue, $maintenant, $voulu) {
        $id = authentifier($etat, texte($entree, 'jeton'));
        synchroniserPronos($etat, $saison, $catalogue, $maintenant);
        $courante = mancheCourantePronos($etat, $saison);
        if ($action === 'monPronostic') {
            $pari = $courante !== null ? ($courante[1]['paris'][$id] ?? null) : null;
            return ['manche' => $courante[0] ?? null, 'statut' => $courante[1]['statut'] ?? null,
                    'pari' => $pari !== null ? detailPari($courante[1], $pari) : null];
        }
        if (!pronosActifs($catalogue)) {
            return [409, 'Les pronostics ne sont pas activés.'];
        }
        if ($courante === null) {
            return [409, 'Aucun GP à pronostiquer pour le moment.'];
        }
        [$n, $m] = $courante;
        if ($voulu !== null && $voulu !== $n) {
            return [409, 'Le GP a changé entre-temps : refais ton pronostic sur le GP affiché.'];
        }
        if ($m['statut'] !== 'ouvert') {
            return [409, 'Les pronostics de ce GP sont fermés : la course a commencé.'];
        }
        $ids = array_keys($m['forces']);
        $meilleur = $entree['meilleur'] ?? null;
        $ordre = $entree['ordre'] ?? null;
        if ($meilleur === null && $ordre === null) {
            return [400, 'Choisis au moins un pronostic.'];
        }
        if ($meilleur !== null && ($m['bases']['meilleur'] <= 0 || !is_string($meilleur) || !in_array($meilleur, $ids, true))) {
            return [400, "Pronostic « meilleur d'entre nous » invalide."];
        }
        if ($ordre !== null) {
            $tri = is_array($ordre) && count($ordre) === count($ids) && array_is_list($ordre) && !array_filter($ordre, fn ($x) => !is_string($x)) ? $ordre : null;
            if ($tri !== null) {
                sort($tri);
                $attendu = $ids;
                sort($attendu);
            }
            if ($m['bases']['ordre'] <= 0 || $tri === null || $tri !== $attendu) {
                return [400, "Pronostic « ordre d'arrivée » invalide : classe chacun des " . count($ids) . ' joueurs une seule fois.'];
            }
        }
        $pari = ['meilleur' => $meilleur, 'ordre' => $ordre, 'le' => $maintenant];
        $etat['pronos']['manches'][$n]['paris'][$id] = $pari;
        return ['ok' => true, 'manche' => $n, 'statut' => 'ouvert', 'pari' => detailPari($m, $pari)];
    });
    if (isset($resultat[0]) && is_int($resultat[0])) {
        erreur($resultat[0], $resultat[1]);
    }
    repondre($resultat);
}

if ($action === 'pronosFermer' || $action === 'pronosOuvrir' || $action === 'pronosAnnuler') {
    // Appelées par l'enregistreur (fermeture au départ de la course) ou depuis l'admin ; idempotentes.
    if (!hash_equals(CLE_ADMIN, texte($entree, 'cle'))) {
        usleep(800000);
        erreur(403, 'Clé administrateur incorrecte.');
    }
    $saison = saison();
    $catalogue = catalogue();
    $maintenant = time();
    // L'appelant indique le GP visé (celui qui démarre pour l'enregistreur, celui que la page d'admin affiche) pour ne pas agir
    // sur un autre si, entre-temps, un GP a été réglé. Sans numéro, on agit sur le GP en cours.
    $voulu = isset($entree['manche']) && is_numeric($entree['manche']) ? (int) $entree['manche'] : null;
    $resultat = modifierEtat(function (array &$etat) use ($action, $saison, $catalogue, $maintenant, $voulu) {
        synchroniserPronos($etat, $saison, $catalogue, $maintenant);
        if ($action === 'pronosFermer' && $voulu !== null) {
            $m = $etat['pronos']['manches'][$voulu] ?? null;
            if ($m === null) {
                // GP pas encore ouvert (le précédent n'est pas encore réglé) : il s'ouvrira déjà fermé
                $gp = array_values(array_filter($saison['calendrier'], fn ($x) => (int) $x['manche'] === $voulu))[0] ?? null;
                if ($gp !== null && courseDeManche($saison, $voulu) === null) {
                    $change = !isset($etat['pronos']['fermesAvance'][$voulu]) || $maintenant - (int) $etat['pronos']['fermesAvance'][$voulu] >= DUREE_FERMETURE_AVANCE;
                    $etat['pronos']['fermesAvance'][$voulu] = $maintenant;
                    return ['ok' => true, 'manche' => $voulu, 'gp' => (string) ($gp['gp'] ?? ''), 'statut' => 'ferme', 'change' => $change];
                }
                return ['ok' => true, 'manche' => $voulu, 'gp' => null, 'statut' => null, 'change' => false];
            }
            $change = $m['statut'] === 'ouvert';
            if ($change) {
                $etat['pronos']['manches'][$voulu]['statut'] = 'ferme';
                $etat['pronos']['manches'][$voulu]['fermeLe'] = $maintenant;
            }
            return ['ok' => true, 'manche' => $voulu, 'gp' => $m['gp'] ?? '', 'statut' => $etat['pronos']['manches'][$voulu]['statut'], 'change' => $change];
        }
        $courante = mancheCourantePronos($etat, $saison);
        if ($voulu !== null && ($courante === null || $courante[0] !== $voulu)) {
            return [409, 'Le GP a changé entre-temps : recharge la page.'];
        }
        if ($courante === null) {
            return ['ok' => true, 'manche' => null, 'gp' => null, 'statut' => null, 'change' => false];
        }
        [$n, $m] = $courante;
        $statut = $m['statut'];
        if ($action === 'pronosOuvrir' && courseDeManche($saison, $n) !== null) {
            return [409, 'La course de ce GP est déjà enregistrée : les pronostics ne peuvent plus être rouverts.'];
        }
        if ($action === 'pronosFermer' && $statut === 'ouvert') {
            $statut = 'ferme';
            $etat['pronos']['manches'][$n]['fermeLe'] = $maintenant;
        } elseif ($action === 'pronosOuvrir' && $statut === 'ferme') {
            $statut = 'ouvert';
            unset($etat['pronos']['manches'][$n]['fermeLe']);
        } elseif ($action === 'pronosAnnuler' && $statut !== 'regle') {
            // GP qui n'aura pas lieu : aucun gain, et les pronostics passent au GP suivant
            $statut = 'regle';
            $etat['pronos']['manches'][$n] += ['gains' => []];
            $etat['pronos']['manches'][$n]['resultat'] = ['course' => '', 'classement' => [], 'absents' => array_keys($m['forces']), 'annulee' => true];
            $etat['pronos']['manches'][$n]['regleLe'] = $maintenant;
        }
        $etat['pronos']['manches'][$n]['statut'] = $statut;
        if ($action === 'pronosAnnuler') {
            synchroniserPronos($etat, $saison, $catalogue, $maintenant);
        }
        return ['ok' => true, 'manche' => $n, 'gp' => $m['gp'] ?? '', 'statut' => $statut, 'change' => $statut !== $m['statut']];
    });
    if (isset($resultat[0]) && is_int($resultat[0])) {
        erreur($resultat[0], $resultat[1]);
    }
    repondre($resultat);
}

if ($action === 'deconnexion') {
    modifierEtat(function (array &$etat) use ($entree) {
        $empreinte = hash('sha256', texte($entree, 'jeton'));
        foreach ($etat['joueurs'] as &$j) {
            $j['jetons'] = array_values(array_filter($j['jetons'], fn ($t) => !hash_equals($t['h'], $empreinte)));
        }
    });
    repondre(['ok' => true]);
}

if ($action === 'reinitialiser') {
    // Efface le mot de passe d'un compte (pilote : son prénom ; spectateur : son pseudo) : la collection est conservée,
    // et le prochain mot de passe saisi à la connexion devient le nouveau.
    if (!hash_equals(CLE_ADMIN, texte($entree, 'cle'))) {
        usleep(800000);
        erreur(403, 'Clé administrateur incorrecte.');
    }
    $saison = saison();
    $nom = texte($entree, 'nom');
    $resultat = modifierEtat(function (array &$etat) use ($saison, $nom) {
        $joueur = joueurParNom($saison, $nom);
        $id = $joueur['id'] ?? spectateurParNom($etat, $nom);
        if ($id === null) {
            return [404, 'Compte inconnu : ce nom n\'est ni un pilote du championnat ni un spectateur.'];
        }
        $j = &$etat['joueurs'][$id];
        $j ??= joueurVierge();
        $j['hash'] = null;
        $j['jetons'] = [];
        $j['echecs'] = [];
        return ['ok' => true];
    });
    if (isset($resultat[0]) && is_int($resultat[0])) {
        erreur($resultat[0], $resultat[1]);
    }
    repondre($resultat);
}

if ($action === 'supprimerSpectateur') {
    // Supprime définitivement le compte d'un spectateur (collection, paris et tirages compris). Jamais un pilote du championnat.
    if (!hash_equals(CLE_ADMIN, texte($entree, 'cle'))) {
        usleep(800000);
        erreur(403, 'Clé administrateur incorrecte.');
    }
    $id = texte($entree, 'id');
    $resultat = modifierEtat(function (array &$etat) use ($id) {
        if (!isset($etat['joueurs'][$id]) || !estSpectateur($etat['joueurs'][$id])) {
            return [404, 'Spectateur inconnu.'];
        }
        $nom = (string) ($etat['joueurs'][$id]['nom'] ?? $id);
        supprimerCompte($etat, $id);
        return ['ok' => true, 'nom' => $nom];
    });
    if (isset($resultat[0]) && is_int($resultat[0])) {
        erreur($resultat[0], $resultat[1]);
    }
    repondre($resultat);
}

erreur(404, 'Action inconnue.');

<?php
// Serveur du jeu de cartes F1 25 : comptes, boosters (gagnés avec les points et offerts à l'heure), fragments, fabrication.
// Contrat complet : API.md. Les données sont dans donnees/etat.json (dossier protégé).
declare(strict_types=1);

require __DIR__ . '/config.php';
date_default_timezone_set('Europe/Paris');

const FICHIER_ETAT = __DIR__ . '/donnees/etat.json';
const CACHE_SAISON = __DIR__ . '/donnees/cache-saison.json';
const CACHE_CATALOGUE = __DIR__ . '/donnees/cache-catalogue.json';
const DUREE_JETON = 180 * 86400;
const TAILLE_FIL = 30;

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
    http_response_code($code);
    echo json_encode($donnees, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
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
                $points[$id] += (float) $r['pointsForces'];
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

/** Exécute $action sur l'état, sous verrou exclusif, puis l'enregistre. */
function modifierEtat(callable $action): mixed
{
    $f = fopen(FICHIER_ETAT, 'c+');
    if ($f === false || !flock($f, LOCK_EX)) {
        erreur(500, "Le serveur n'arrive pas à enregistrer les données (droits du dossier donnees ?).");
    }
    $brut = stream_get_contents($f);
    $etat = $brut ? json_decode($brut, true) : null;
    if (!is_array($etat)) {
        $etat = etatVierge();
    }
    try {
        $resultat = $action($etat);
        ftruncate($f, 0);
        rewind($f);
        fwrite($f, json_encode($etat, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES));
        fflush($f);
    } finally {
        flock($f, LOCK_UN);
        fclose($f);
    }
    return $resultat;
}

function lireEtat(): array
{
    if (!is_file(FICHIER_ETAT)) {
        return etatVierge();
    }
    $etat = json_decode((string) file_get_contents(FICHIER_ETAT), true);
    return is_array($etat) ? $etat : etatVierge();
}

function corps(): array
{
    $donnees = json_decode((string) file_get_contents('php://input'), true);
    return is_array($donnees) ? $donnees : [];
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

/** Boosters gagnés = points / pointsParBooster (arrondi en dessous) + boosters bonus donnés dans l'admin. */
function boostersGagnes(array $saison, array $catalogue, string $id): int
{
    $ratio = max(1, (float) ($catalogue['pointsParBooster'] ?? 1));
    $bonus = 0;
    foreach ($saison['joueurs'] as $j) {
        if ($j['id'] === $id) {
            $bonus = (int) ($j['boostersBonus'] ?? 0);
        }
    }
    return max(0, (int) floor((pointsJoueurs($saison)[$id] ?? 0) / $ratio) + $bonus);
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
        foreach ($saison['joueurs'] as $j) {
            $e = &$etat['joueurs'][$j['id']];
            $e ??= joueurVierge();
            [$stock, $depuis] = calculerOfferts($e['offerts'] ?? null, $maintenant, (int) $anciens['intervalle'], (int) $anciens['max'], (int) $ancre);
            $e['offerts'] = ['stock' => $stock, 'depuis' => $depuis];
            unset($e);
        }
    }
    $etat['offertsReglages'] = ['intervalle' => $intervalle, 'max' => $max];
}

function etatModifiable(): bool
{
    return is_file(FICHIER_ETAT) ? is_writable(FICHIER_ETAT) : is_writable(dirname(FICHIER_ETAT));
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
    $total = array_sum(array_column($candidates, 'poids'));
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

function ajouterAuFil(array &$etat, string $joueur, string $carte, bool $fabriquee): void
{
    array_unshift($etat['fil'], ['joueur' => $joueur, 'carte' => $carte, 'date' => date('c'), 'fabriquee' => $fabriquee]);
    $etat['fil'] = array_slice($etat['fil'], 0, TAILLE_FIL);
}

const RARETES_DU_FIL = ['icone', 'legendaire', 'epique'];

$action = $_GET['action'] ?? '';
$methode = $_SERVER['REQUEST_METHOD'] ?? 'GET';

if ($action === 'etat' && $methode === 'GET') {
    $saison = saison();
    $catalogue = catalogue();
    $etat = lireEtat();
    $maintenant = time();
    [$intervalle, $maxOffert] = reglagesOfferts($catalogue);
    if (reglagesOffertsAChanger($etat, $intervalle, $maxOffert) && etatModifiable()) {
        // première fois, ou réglages changés dans l'admin : enregistré une seule fois (voir appliquerReglagesOfferts)
        $etat = modifierEtat(function (array &$e) use ($saison, $intervalle, $maxOffert, $maintenant) {
            appliquerReglagesOfferts($e, $saison, $intervalle, $maxOffert, $maintenant);
            return $e;
        });
    }
    $ancre = (int) ($etat['offertsDepuis'] ?? $maintenant);
    $points = pointsJoueurs($saison);
    $joueurs = [];
    foreach ($saison['joueurs'] as $j) {
        $e = $etat['joueurs'][$j['id']] ?? joueurVierge();
        $gagnes = boostersGagnes($saison, $catalogue, $j['id']);
        $offerts = vueOfferts($e, $maintenant, $intervalle, $maxOffert, $ancre);
        $joueur = [
            'id' => $j['id'], 'nom' => $j['nom'], 'compte' => $e['hash'] !== null, 'points' => $points[$j['id']],
            'boostersGagnes' => $gagnes, 'boostersOuverts' => $e['ouverts'],
            'boostersDispo' => max(0, $gagnes - $e['ouverts']) + ($offerts['stock'] ?? 0), 'fragments' => $e['fragments'],
            'cartes' => array_keys($e['cartes']), 'nbCartes' => count($e['cartes']),
        ];
        if ($offerts !== null) {
            $joueur['offerts'] = $offerts;
        }
        $joueurs[] = $joueur;
    }
    repondre(['joueurs' => $joueurs, 'fil' => $etat['fil'], 'totalCartes' => count($catalogue['cartes'])]);
}

if ($methode !== 'POST') {
    erreur(405, 'Action inconnue.');
}
$entree = corps();

if ($action === 'connexion') {
    $saison = saison();
    $joueur = joueurParNom($saison, (string) ($entree['nom'] ?? ''));
    if (!$joueur) {
        erreur(404, 'Ce prénom ne fait pas partie du championnat.');
    }
    $motDePasse = (string) ($entree['motDePasse'] ?? '');
    $resultat = modifierEtat(function (array &$etat) use ($joueur, $motDePasse) {
        $j = &$etat['joueurs'][$joueur['id']];
        $j ??= joueurVierge();
        $j['echecs'] = array_values(array_filter($j['echecs'], fn ($t) => $t > time() - 600));
        if (count($j['echecs']) >= 10) {
            return [429, 'Trop d\'essais : réessaie dans 10 minutes.'];
        }
        $premiere = $j['hash'] === null;
        if ($premiere) {
            if (mb_strlen($motDePasse) < 4) {
                return [400, 'Choisis un mot de passe d\'au moins 4 caractères.'];
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
        return ['jeton' => $jeton, 'joueur' => $joueur['id'], 'nom' => $joueur['nom'], 'premiereConnexion' => $premiere];
    });
    if (isset($resultat[0]) && is_int($resultat[0])) {
        if ($resultat[0] === 401) {
            usleep(800000);
        }
        erreur($resultat[0], $resultat[1]);
    }
    repondre($resultat);
}

if ($action === 'ouvrir') {
    $saison = saison();
    $catalogue = catalogue();
    [$cartes, $parRarete, $raretes] = indexer($catalogue);
    [$intervalle, $maxOffert] = reglagesOfferts($catalogue);
    $maintenant = time();
    $nombre = max(1, min(100, (int) ($entree['nombre'] ?? 1)));
    $resultat = modifierEtat(function (array &$etat) use ($entree, $saison, $catalogue, $cartes, $parRarete, $raretes, $nombre, $intervalle, $maxOffert, $maintenant) {
        $id = authentifier($etat, (string) ($entree['jeton'] ?? ''));
        appliquerReglagesOfferts($etat, $saison, $intervalle, $maxOffert, $maintenant);
        $ancre = (int) $etat['offertsDepuis'];
        $j = &$etat['joueurs'][$id];
        [$offerts, $depuis] = calculerOfferts($j['offerts'] ?? null, $maintenant, $intervalle, $maxOffert, $ancre);
        $dispoPoints = max(0, boostersGagnes($saison, $catalogue, $id) - $j['ouverts']);
        if ($dispoPoints + $offerts <= 0) {
            return ['aucun' => $intervalle > 0 ? max(0, $depuis + $intervalle - $maintenant) : null];
        }
        $aOuvrir = min($nombre, $dispoPoints + $offerts);
        $boosters = [];
        for ($b = 0; $b < $aOuvrir; $b++) {
            $booster = [];
            for ($k = 0; $k < $catalogue['cartesParBooster']; $k++) {
                $carte = tirer($catalogue, $parRarete, $k === $catalogue['cartesParBooster'] - 1);
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
                    'boostersDispo' => max(0, boostersGagnes($saison, $catalogue, $id) - $j['ouverts']) + $offerts];
        $vue = vueOfferts($j, $maintenant, $intervalle, $maxOffert, $ancre);
        if ($vue !== null) {
            $reponse['offerts'] = $vue;
        }
        return $reponse;
    });
    if (array_key_exists('aucun', $resultat)) {
        $attente = $resultat['aucun'];
        erreur(409, $attente === null
            ? 'Aucun booster disponible : marque des points au prochain GP !'
            : 'Aucun booster disponible : le prochain booster offert arrive dans ' . max(1, intdiv($attente + 59, 60)) . ' min, ou marque des points au prochain GP !');
    }
    repondre($resultat);
}

if ($action === 'fabriquer') {
    $catalogue = catalogue();
    [$cartes, , $raretes] = indexer($catalogue);
    $carte = (string) ($entree['carte'] ?? '');
    if (!isset($cartes[$carte])) {
        erreur(404, 'Carte inconnue.');
    }
    $cout = (int) ($cartes[$carte]['cout'] ?? $raretes[$cartes[$carte]['rarete']]['cout']);
    $resultat = modifierEtat(function (array &$etat) use ($entree, $carte, $cout, $cartes) {
        $id = authentifier($etat, (string) ($entree['jeton'] ?? ''));
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

if ($action === 'deconnexion') {
    modifierEtat(function (array &$etat) use ($entree) {
        $empreinte = hash('sha256', (string) ($entree['jeton'] ?? ''));
        foreach ($etat['joueurs'] as &$j) {
            $j['jetons'] = array_values(array_filter($j['jetons'], fn ($t) => !hash_equals($t['h'], $empreinte)));
        }
    });
    repondre(['ok' => true]);
}

if ($action === 'reinitialiser') {
    if (!hash_equals(CLE_ADMIN, (string) ($entree['cle'] ?? ''))) {
        usleep(800000);
        erreur(403, 'Clé administrateur incorrecte.');
    }
    $joueur = joueurParNom(saison(), (string) ($entree['nom'] ?? ''));
    if (!$joueur) {
        erreur(404, 'Ce prénom ne fait pas partie du championnat.');
    }
    modifierEtat(function (array &$etat) use ($joueur) {
        $j = &$etat['joueurs'][$joueur['id']];
        $j ??= joueurVierge();
        $j['hash'] = null;
        $j['jetons'] = [];
        $j['echecs'] = [];
    });
    repondre(['ok' => true]);
}

erreur(404, 'Action inconnue.');

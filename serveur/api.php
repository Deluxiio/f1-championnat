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
            if ($total > 0) {
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
 */
function synchroniserPronos(array &$etat, array $saison, array $catalogue, int $maintenant): bool
{
    $change = false;
    $etat['pronos']['manches'] ??= [];
    $manches = &$etat['pronos']['manches'];
    foreach ($manches as $n => &$m) {
        if (($m['statut'] ?? '') === 'regle') {
            continue;
        }
        $course = courseDeManche($saison, (int) $n);
        if ($course !== null) {
            reglerManchePronos($etat, $m, $course, $saison, $maintenant);
            $change = true;
        }
    }
    unset($m);
    if (pronosActifs($catalogue)) {
        $gp = prochaineManchePronos($saison, $manches);
        if ($gp !== null && !isset($manches[(int) $gp['manche']])) {
            [$base, $baseOrdre, $max, $lissage] = reglagesPronos($catalogue);
            $forces = forcesPronos($saison, $lissage);
            $manches[(int) $gp['manche']] = [
                'statut' => isset($etat['pronos']['fermesAvance'][(int) $gp['manche']]) ? 'ferme' : 'ouvert',
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

/** Le GP dont les pronostics sont en cours (ouverts ou fermés, pas encore réglés) : [numéro, données] ou null. */
function mancheCourantePronos(array $etat): ?array
{
    foreach (($etat['pronos']['manches'] ?? []) as $n => $m) {
        if (($m['statut'] ?? '') !== 'regle') {
            return [(int) $n, $m];
        }
    }
    return null;
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
    $courante = mancheCourantePronos($etat);
    $historique = [];
    $classement = [];
    foreach ($saison['joueurs'] as $j) {
        $classement[$j['id']] = ['joueur' => $j['id'], 'boosters' => 0, 'bonsMeilleur' => 0, 'bonsOrdre' => 0, 'paris' => 0];
    }
    foreach ($manches as $n => $m) {
        if (($m['statut'] ?? '') !== 'regle') {
            continue;
        }
        $historique[] = ['manche' => (int) $n, 'gp' => (string) ($m['gp'] ?? ''), 'resultat' => $m['resultat'] ?? null,
                         'gains' => $m['gains'] ?? [], 'paris' => array_map(fn ($p) => array_intersect_key($p, ['meilleur' => 1, 'ordre' => 1]), $m['paris'] ?? [])];
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
    $classement = array_values($classement);
    usort($classement, fn ($a, $b) => [$b['boosters'], $b['bonsMeilleur'] + $b['bonsOrdre']] <=> [$a['boosters'], $a['bonsMeilleur'] + $a['bonsOrdre']]);
    $vue = ['actif' => $actif, 'manche' => null, 'gp' => null, 'statut' => null, 'bases' => null, 'forces' => null, 'cotes' => null,
            'aParie' => [], 'historique' => array_slice($historique, 0, 6), 'classement' => $classement];
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
        if ($m['statut'] !== 'ouvert') {
            $vue['paris'] = array_map(fn ($p) => array_intersect_key($p, ['meilleur' => 1, 'ordre' => 1]), $m['paris']);
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
    $total = array_sum(array_column($candidates, 'poids'));
    if ($total < 1) {  // réglage absurde (dernière carte « au minimum Mythique », qui n'a pas de poids) : la rareté la plus basse permise
        $liste = $parRarete[end($candidates)['id']];
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

/** Chance (de 0 à 1) qu'une carte tirée soit une Mythique, pour qu'un booster sur 100 en contienne une (réglage chanceMythiqueParBooster, en %). */
function chanceMythiqueParCarte(array $catalogue): float
{
    $pourcent = is_numeric($catalogue['chanceMythiqueParBooster'] ?? null) ? (float) $catalogue['chanceMythiqueParBooster'] : 1.0;
    $p = max(0.0, min(100.0, $pourcent)) / 100;
    $cartes = max(1, (int) ($catalogue['cartesParBooster'] ?? 5));
    return 1 - (1 - $p) ** (1 / $cartes);
}

/**
 * Tirage ultra rare d'une carte Mythique (les cartes des potes) : null si le sort n'est pas tombé.
 * Une Mythique que le joueur n'a pas encore passe avant un doublon.
 */
function tirerMythique(float $chance, array $parRarete, array $possedees): ?string
{
    $liste = $parRarete['mythique'] ?? [];
    if ($chance <= 0 || !$liste || random_int(1, 1000000) > (int) round($chance * 1000000)) {
        return null;
    }
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
        $pronos = (int) ($e['boostersPronos'] ?? 0);
        $gagnes = boostersGagnes($saison, $catalogue, $j['id'], $pronos);
        $offerts = vueOfferts($e, $maintenant, $intervalle, $maxOffert, $ancre);
        $joueur = [
            'id' => $j['id'], 'nom' => $j['nom'], 'compte' => $e['hash'] !== null, 'points' => $points[$j['id']],
            'boostersGagnes' => $gagnes, 'boostersPronos' => $pronos, 'boostersOuverts' => $e['ouverts'],
            'boostersDispo' => max(0, $gagnes - $e['ouverts']) + ($offerts['stock'] ?? 0), 'fragments' => $e['fragments'],
            'cartes' => array_keys($e['cartes']), 'nbCartes' => count($e['cartes']),
        ];
        if ($offerts !== null) {
            $joueur['offerts'] = $offerts;
        }
        $joueurs[] = $joueur;
    }
    repondre(['joueurs' => $joueurs, 'fil' => $etat['fil'], 'totalCartes' => count($catalogue['cartes']),
              'pronos' => vuePronos($etat, $saison, $catalogue)]);
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
    $chanceMythique = chanceMythiqueParCarte($catalogue);
    $maintenant = time();
    $nombre = max(1, min(100, (int) ($entree['nombre'] ?? 1)));
    $resultat = modifierEtat(function (array &$etat) use ($entree, $saison, $catalogue, $cartes, $parRarete, $raretes, $nombre, $intervalle, $maxOffert, $maintenant, $chanceMythique) {
        $id = authentifier($etat, (string) ($entree['jeton'] ?? ''));
        appliquerReglagesOfferts($etat, $saison, $intervalle, $maxOffert, $maintenant);
        synchroniserPronos($etat, $saison, $catalogue, $maintenant);  // les gains d'un GP tout juste réglé comptent tout de suite
        $ancre = (int) $etat['offertsDepuis'];
        $j = &$etat['joueurs'][$id];
        [$offerts, $depuis] = calculerOfferts($j['offerts'] ?? null, $maintenant, $intervalle, $maxOffert, $ancre);
        $dispoPoints = max(0, boostersGagnes($saison, $catalogue, $id, (int) ($j['boostersPronos'] ?? 0)) - $j['ouverts']);
        if ($dispoPoints + $offerts <= 0) {
            return ['aucun' => $intervalle > 0 ? max(0, $depuis + $intervalle - $maintenant) : null];
        }
        $aOuvrir = min($nombre, $dispoPoints + $offerts);
        $boosters = [];
        for ($b = 0; $b < $aOuvrir; $b++) {
            $booster = [];
            for ($k = 0; $k < $catalogue['cartesParBooster']; $k++) {
                $carte = tirerMythique($chanceMythique, $parRarete, $j['cartes'])
                    ?? tirer($catalogue, $parRarete, $k === $catalogue['cartesParBooster'] - 1);
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
    if ($cartes[$carte]['rarete'] === 'mythique') {
        erreur(409, 'Les cartes Mythiques ne se fabriquent pas : elles se trouvent uniquement dans les boosters.');
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

if ($action === 'pronostiquer' || $action === 'monPronostic') {
    $saison = saison();
    $catalogue = catalogue();
    $maintenant = time();
    $resultat = modifierEtat(function (array &$etat) use ($action, $entree, $saison, $catalogue, $maintenant) {
        $id = authentifier($etat, (string) ($entree['jeton'] ?? ''));
        synchroniserPronos($etat, $saison, $catalogue, $maintenant);
        $courante = mancheCourantePronos($etat);
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
    if (!hash_equals(CLE_ADMIN, (string) ($entree['cle'] ?? ''))) {
        usleep(800000);
        erreur(403, 'Clé administrateur incorrecte.');
    }
    $saison = saison();
    $catalogue = catalogue();
    $maintenant = time();
    // L'enregistreur indique le GP qui démarre ; sans numéro (bouton de l'admin), c'est le GP en cours
    $cible = $action === 'pronosFermer' && isset($entree['manche']) && is_numeric($entree['manche']) ? (int) $entree['manche'] : null;
    $resultat = modifierEtat(function (array &$etat) use ($action, $saison, $catalogue, $maintenant, $cible) {
        synchroniserPronos($etat, $saison, $catalogue, $maintenant);
        if ($cible !== null) {
            $m = $etat['pronos']['manches'][$cible] ?? null;
            if ($m === null) {
                // GP pas encore ouvert (le précédent n'est pas encore réglé) : il s'ouvrira déjà fermé
                $gp = array_values(array_filter($saison['calendrier'], fn ($x) => (int) $x['manche'] === $cible))[0] ?? null;
                if ($gp !== null && courseDeManche($saison, $cible) === null) {
                    $etat['pronos']['fermesAvance'][$cible] = $maintenant;
                    return ['ok' => true, 'manche' => $cible, 'gp' => (string) ($gp['gp'] ?? ''), 'statut' => 'ferme'];
                }
                return ['ok' => true, 'manche' => $cible, 'gp' => null, 'statut' => null];
            }
            if ($m['statut'] === 'ouvert') {
                $etat['pronos']['manches'][$cible]['statut'] = 'ferme';
                $etat['pronos']['manches'][$cible]['fermeLe'] = $maintenant;
            }
            return ['ok' => true, 'manche' => $cible, 'gp' => $m['gp'] ?? '', 'statut' => $etat['pronos']['manches'][$cible]['statut']];
        }
        $courante = mancheCourantePronos($etat);
        if ($courante === null) {
            return ['ok' => true, 'manche' => null, 'gp' => null, 'statut' => null];
        }
        [$n, $m] = $courante;
        $statut = $m['statut'];
        if ($action === 'pronosFermer' && $statut === 'ouvert') {
            $statut = 'ferme';
            $etat['pronos']['manches'][$n]['fermeLe'] = $maintenant;
        } elseif ($action === 'pronosOuvrir' && $statut === 'ferme') {
            $statut = 'ouvert';
            unset($etat['pronos']['manches'][$n]['fermeLe']);
        } elseif ($action === 'pronosAnnuler') {
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
        return ['ok' => true, 'manche' => $n, 'gp' => $m['gp'] ?? '', 'statut' => $statut];
    });
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

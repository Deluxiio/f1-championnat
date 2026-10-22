# API du jeu de cartes

Serveur PHP hébergé chez Hostinger (`api.php`). La page `docs/cartes/` l'appelle. Toutes les réponses sont du JSON en UTF-8. En cas d'erreur, le serveur renvoie un code HTTP ≠ 200 et `{"erreur": "message lisible en français"}`.

Le serveur lit lui-même `data/saison.json` (points des joueurs) et `cartes/catalogue.json` sur GitHub Pages. Les boosters gagnés ne peuvent donc pas être falsifiés côté navigateur.

## Règles
Tous les réglages se font dans l'admin locale, bloc **Cartes**, et sont publiés dans `catalogue.json` et `saison.json`. Le serveur relit le catalogue toutes les 5 minutes.

- **Boosters gagnés** = points du joueur au championnat ÷ `catalogue.pointsParBooster` (arrondi en dessous) + `boostersBonus` du joueur dans `saison.json` + boosters gagnés aux pronostics (`boostersPronos`). Les points forcés comptent.
- **Boosters offerts** : chaque joueur reçoit 1 booster toutes les `catalogue.minutesParBoosterOffert` minutes (60 par défaut, 0 = désactivé), sans rien faire, et les garde en stock jusqu'à `catalogue.stockMaxBoostersOfferts` (10 par défaut). Quand le stock est plein le compteur s'arrête, et il repart à l'ouverture d'un booster. Au lancement du système tous les stocks partent de 0. À l'ouverture, les boosters offerts passent avant ceux gagnés avec les points : leur stock est plafonné, les autres ne disparaissent jamais. Le serveur compte seul le temps ; le navigateur ne fait qu'afficher le compte à rebours.
  Un changement de réglage (durée, stock maximum, activation) ne vaut que pour la suite : dès que le serveur le voit, il arrête les comptes de tous les joueurs avec les anciens réglages (`offertsReglages` dans `etat.json`), donc rien n'est crédité après coup et réactiver le système ne remplit pas les stocks d'un coup. Seul un plafond abaissé ramène les stocks plus grands au nouveau plafond. Un système désactivé garde les boosters déjà accumulés, qui restent ouvrables.
- **Booster** = `catalogue.cartesParBooster` cartes. Chaque carte est tirée d'abord par rareté (`poids` dans `catalogue.raretes`), puis au hasard parmi les cartes de cette rareté. La dernière carte est au minimum `catalogue.derniereCarteMin`.
- **Cartes Mythiques** (`rarete: "mythique"`, la rareté au-dessus de toutes) : les 4 cartes des potes, générées par `outils/catalogue.py` à partir des joueurs de `saison.json` (`ami` = id du joueur, `numeroCourse`, `couleurs`). Elles ne passent pas par les `poids` : à chaque carte tirée, un tirage à part leur donne une chance telle qu'un booster sur 100 en contienne une (`catalogue.chanceMythiqueParBooster`, en %, 1 par défaut, 0 = aucune). Une Mythique que le joueur n'a pas encore passe avant un doublon. Un doublon vaut `fragments` de sa rareté (1000) et elles ne se fabriquent pas (409). La page calcule leurs chiffres (victoires, podiums, points, note) depuis `data/saison.json`.
- **Pronostics** : avant chaque GP, chaque joueur pronostique sans rien miser « le meilleur d'entre nous » (`meilleur`) et/ou « l'ordre d'arrivée » de tous les joueurs (`ordre`). Réglages du catalogue : `pronosGainMeilleur` (2) et `pronosGainOrdre` (4) = boosters de base de chaque pari (0 aux deux = désactivé), `pronosGainMax` (60) = gain maximum d'un pari, `pronosLissage` (15) = points ajoutés à chacun pour calculer les cotes.
  - Le serveur ouvre le premier GP du calendrier qui n'a pas de course enregistrée (et pas déjà réglé). À l'ouverture il fige `forces` (points au championnat + lissage), les `cotes` du « meilleur » (1 / probabilité, arrondies au dixième, entre 1,1 et `gainMax` ÷ base) et les `bases` : un changement de réglage ne vaut que pour le GP suivant. La cote d'un ordre se calcule à la demande avec les mêmes `forces` (modèle de Plackett-Luce : la place de chacun est tirée selon les forces restantes). Gain d'un pari juste = `min(gainMax, max(1, base × cote))`, arrondi à l'entier.
  - Les paris sont secrets tant que le GP est `ouvert`. Ils se ferment au départ de la course (`ferme`), appelés par l'enregistreur ou l'admin. Quand la course du GP apparaît dans `saison.json`, le GP est réglé une seule fois, sous verrou : ordre d'arrivée des joueurs, gains crédités dans `boostersPronos`, GP suivant ouvert. Un joueur absent est retiré de l'ordre pronostiqué (la cote est recalculée sans lui) ; avec moins de deux joueurs au départ le GP est annulé (aucun gain).
  - Règlement et ouverture se font au premier appel d'`etat`, `ouvrir` ou `pronostiquer` qui suit, donc quelques minutes après la course (publication GitHub + cache de 60 s).
- **Doublon** : une carte déjà possédée est recyclée automatiquement en `fragments` (valeur selon sa rareté). On ne garde jamais deux fois la même carte.
- **Fabrication** : une carte manquante coûte son propre `cout` s'il existe, sinon le `cout` de sa rareté.
- **Cartes modifiées à la main** : `perso` contient ce qui a été changé (rareté, note, prix, phrase) et `auto` les valeurs calculées à partir du palmarès. `outils/catalogue.py` conserve ces réglages quand il régénère le catalogue.

## Appels

### `GET api.php?action=etat` — public
```json
{
  "joueurs": [
    {"id": "joueur1", "nom": "Valentin", "compte": true, "points": 12,
     "boostersGagnes": 12, "boostersPronos": 4, "boostersOuverts": 5, "boostersDispo": 10,
     "offerts": {"stock": 3, "max": 10, "intervalle": 3600, "prochainDans": 1380, "ouverts": 12},
     "fragments": 34, "cartes": ["michael_schumacher--ferrari", "..."], "nbCartes": 23}
  ],
  "fil": [{"joueur": "joueur2", "carte": "alonso--renault", "date": "2026-10-21T22:14:03+02:00", "fabriquee": false}],
  "totalCartes": 714,
  "pronos": {
    "actif": true, "manche": 4, "gp": "Bahreïn", "statut": "ouvert",
    "bases": {"meilleur": 2, "ordre": 4, "max": 60},
    "forces": {"joueur1": 15, "joueur2": 83, "joueur3": 29, "joueur4": 58},
    "cotes": {"meilleur": {"joueur1": 12.3, "joueur2": 2.2, "joueur3": 6.4, "joueur4": 3.2}},
    "aParie": {"joueur1": true, "joueur2": false, "joueur3": false, "joueur4": true},
    "paris": {"joueur1": {"meilleur": "joueur2", "ordre": ["joueur2", "joueur1", "joueur4", "joueur3"]}},
    "historique": [{"manche": 3, "gp": "Japon", "resultat": {"course": "…", "classement": ["joueur2", "joueur1"], "absents": ["joueur3", "joueur4"], "annulee": false},
                    "gains": {"joueur1": {"meilleur": 0, "ordre": 60}}, "paris": {"joueur1": {"meilleur": "joueur4", "ordre": ["…"]}}}],
    "classement": [{"joueur": "joueur1", "boosters": 60, "bonsMeilleur": 0, "bonsOrdre": 1, "paris": 3}]
  }
}
```
`compte` = le joueur a déjà choisi son mot de passe. `fil` = les 30 dernières cartes Épique ou mieux obtenues (la plus récente en premier).

`boostersGagnes` et `boostersOuverts` ne comptent que les boosters gagnés (points, bonus et pronostics ; `boostersPronos` = la part venant des pronostics). `boostersDispo` est le total à ouvrir : (`boostersGagnes` − `boostersOuverts`) + `offerts.stock`.
`pronos` décrit les pronostics : `manche`, `gp` et `statut` (`ouvert` ou `ferme`) du GP en cours (`null` s'il n'y en a pas), les `bases` et `cotes` figées à l'ouverture, `aParie` (qui a déjà parié, sans le contenu), `paris` (le contenu des paris de tous, **seulement quand le GP n'est plus `ouvert`**), les 6 derniers GP réglés (`historique`) et le `classement` de la saison. Le bloc est absent avec une ancienne version de `api.php` : la page cache alors l'onglet Pronostics. `actif: false` = pronostics désactivés dans le catalogue.
`offerts` décrit les boosters offerts : `stock` en réserve sur `max`, `intervalle` en secondes entre deux boosters, `prochainDans` = secondes avant le prochain (`null` quand le stock est plein ou le système désactivé), `ouverts` = nombre de boosters offerts déjà ouverts. Le champ est absent quand le système est désactivé et que le stock est vide (et avec une ancienne version de `api.php`) : la page n'affiche alors rien.

### `POST api.php?action=connexion`
Corps : `{"nom": "Valentin", "motDePasse": "…"}`. Si le joueur n'a pas encore de mot de passe, celui-ci est enregistré (4 caractères minimum).
Réponse : `{"jeton": "…", "joueur": "joueur1", "nom": "Valentin", "premiereConnexion": true}`.
Erreurs : 404 nom inconnu, 401 mauvais mot de passe, 429 trop d'essais.

### `POST api.php?action=ouvrir`
Corps : `{"jeton": "…", "nombre": 1}` (1 à 100, plafonné aux boosters disponibles).
Réponse :
```json
{"boosters": [[{"carte": "id", "nouvelle": true, "fragments": 0}, "… 5 cartes"]],
 "fragments": 40, "boostersOuverts": 5, "boostersDispo": 9,
 "offerts": {"stock": 2, "max": 10, "intervalle": 3600, "prochainDans": 1380, "ouverts": 13}}
```
`fragments` (par carte) = fragments gagnés si c'était un doublon (0 sinon). `boostersOuverts` et `offerts` ont le même sens que dans `etat` (à jour après l'ouverture). Erreurs : 401 jeton invalide, 409 aucun booster disponible (le message indique dans combien de minutes arrive le prochain booster offert).

### `POST api.php?action=fabriquer`
Corps : `{"jeton": "…", "carte": "id"}`. Réponse : `{"carte": "id", "fragments": 12}`.
Erreurs : 401, 404 carte inconnue, 409 déjà possédée, fragments insuffisants ou carte Mythique (elles ne se fabriquent pas).

### `POST api.php?action=pronostiquer`
Corps : `{"jeton": "…", "meilleur": "joueur2", "ordre": ["joueur2", "joueur1", "joueur4", "joueur3"]}`. Au moins un des deux ; `ordre` doit contenir une fois chacun des joueurs du GP. Le pari enregistré **remplace** l'ancien (on peut le modifier jusqu'à la fermeture) : un champ absent ou `null` retire ce pari.
Réponse : `{"ok": true, "manche": 4, "statut": "ouvert", "pari": {"meilleur": …, "ordre": …, "cotes": {"meilleur": 2.2, "ordre": 15}, "gains": {"meilleur": 4, "ordre": 60}}}` (`cotes` et `gains` = ce que rapporterait le pari s'il est juste).
Erreurs : 401, 400 pari invalide, 409 pronostics désactivés, aucun GP à pronostiquer ou GP fermé.

### `POST api.php?action=monPronostic`
Corps : `{"jeton": "…"}`. Réponse : `{"manche": 4, "statut": "ouvert", "pari": {…comme ci-dessus…} | null}` : le pari du joueur sur le GP en cours (les paris des autres sont cachés tant que le GP est ouvert).

### `POST api.php?action=pronosFermer` · `pronosOuvrir` · `pronosAnnuler` — réservés à Valentin
Corps : `{"cle": "<CLE_ADMIN de config.php>"}` ; `pronosFermer` accepte aussi `"manche": 4` (le numéro du GP qui démarre : l'enregistreur l'envoie, ce qui fonctionne même si le GP précédent n'est pas encore réglé : le GP s'ouvrira alors déjà fermé). Sans numéro, on agit sur le GP en cours. `pronosFermer` ferme les paris, `pronosOuvrir` les rouvre, `pronosAnnuler` annule le GP en cours (aucun gain) et ouvre le suivant. Toutes sont sans effet si le GP est déjà dans l'état demandé. Réponse : `{"ok": true, "manche": 4, "gp": "Bahreïn", "statut": "ferme"}` (`statut` `regle` pour un GP annulé ou déjà réglé, `null` s'il n'y a rien à faire). Erreur : 403 clé incorrecte.

### `POST api.php?action=deconnexion`
Corps : `{"jeton": "…"}`. Réponse : `{"ok": true}`.

### `POST api.php?action=reinitialiser` — réservé à Valentin
Corps : `{"cle": "<CLE_ADMIN de config.php>", "nom": "Joris"}`. Efface le mot de passe (la collection est conservée). Le joueur en choisira un nouveau à sa prochaine connexion.

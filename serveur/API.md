# API du jeu de cartes

Serveur PHP hébergé chez Hostinger (`api.php`). La page `docs/cartes/` l'appelle. Toutes les réponses sont du JSON en UTF-8. En cas d'erreur, le serveur renvoie un code HTTP ≠ 200 et `{"erreur": "message lisible en français"}`.

Le serveur lit lui-même `data/saison.json` (points des joueurs) et `cartes/catalogue.json` sur GitHub Pages. Les boosters gagnés ne peuvent donc pas être falsifiés côté navigateur.

## Règles
Tous les réglages se font dans l'admin locale, bloc **Cartes**, et sont publiés dans `catalogue.json` et `saison.json`. Le serveur relit le catalogue toutes les 5 minutes.

- **Boosters gagnés** = points du joueur au championnat ÷ `catalogue.pointsParBooster` (arrondi en dessous) + `boostersBonus` du joueur dans `saison.json`. Les points forcés comptent.
- **Boosters offerts** : chaque joueur reçoit 1 booster toutes les `catalogue.minutesParBoosterOffert` minutes (60 par défaut, 0 = désactivé), sans rien faire, et les garde en stock jusqu'à `catalogue.stockMaxBoostersOfferts` (10 par défaut). Quand le stock est plein le compteur s'arrête, et il repart à l'ouverture d'un booster. Au lancement du système tous les stocks partent de 0. À l'ouverture, les boosters offerts passent avant ceux gagnés avec les points : leur stock est plafonné, les autres ne disparaissent jamais. Le serveur compte seul le temps ; le navigateur ne fait qu'afficher le compte à rebours.
  Un changement de réglage (durée, stock maximum, activation) ne vaut que pour la suite : dès que le serveur le voit, il arrête les comptes de tous les joueurs avec les anciens réglages (`offertsReglages` dans `etat.json`), donc rien n'est crédité après coup et réactiver le système ne remplit pas les stocks d'un coup. Seul un plafond abaissé ramène les stocks plus grands au nouveau plafond. Un système désactivé garde les boosters déjà accumulés, qui restent ouvrables.
- **Booster** = `catalogue.cartesParBooster` cartes. Chaque carte est tirée d'abord par rareté (`poids` dans `catalogue.raretes`), puis au hasard parmi les cartes de cette rareté. La dernière carte est au minimum `catalogue.derniereCarteMin`.
- **Doublon** : une carte déjà possédée est recyclée automatiquement en `fragments` (valeur selon sa rareté). On ne garde jamais deux fois la même carte.
- **Fabrication** : une carte manquante coûte son propre `cout` s'il existe, sinon le `cout` de sa rareté.
- **Cartes modifiées à la main** : `perso` contient ce qui a été changé (rareté, note, prix, phrase) et `auto` les valeurs calculées à partir du palmarès. `outils/catalogue.py` conserve ces réglages quand il régénère le catalogue.

## Appels

### `GET api.php?action=etat` — public
```json
{
  "joueurs": [
    {"id": "joueur1", "nom": "Valentin", "compte": true, "points": 12,
     "boostersGagnes": 12, "boostersOuverts": 5, "boostersDispo": 10,
     "offerts": {"stock": 3, "max": 10, "intervalle": 3600, "prochainDans": 1380, "ouverts": 12},
     "fragments": 34, "cartes": ["michael_schumacher--ferrari", "..."], "nbCartes": 23}
  ],
  "fil": [{"joueur": "joueur2", "carte": "alonso--renault", "date": "2026-10-21T22:14:03+02:00", "fabriquee": false}],
  "totalCartes": 302
}
```
`compte` = le joueur a déjà choisi son mot de passe. `fil` = les 30 dernières cartes Épique ou mieux obtenues (la plus récente en premier).

`boostersGagnes` et `boostersOuverts` ne comptent que les boosters gagnés avec les points. `boostersDispo` est le total à ouvrir : (`boostersGagnes` − `boostersOuverts`) + `offerts.stock`.
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
Erreurs : 401, 404 carte inconnue, 409 déjà possédée ou fragments insuffisants.

### `POST api.php?action=deconnexion`
Corps : `{"jeton": "…"}`. Réponse : `{"ok": true}`.

### `POST api.php?action=reinitialiser` — réservé à Valentin
Corps : `{"cle": "<CLE_ADMIN de config.php>", "nom": "Joris"}`. Efface le mot de passe (la collection est conservée). Le joueur en choisira un nouveau à sa prochaine connexion.

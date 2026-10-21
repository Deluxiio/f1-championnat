# API du jeu de cartes

Serveur PHP hébergé chez Hostinger (`api.php`). La page `docs/cartes/` l'appelle. Toutes les réponses sont du JSON en UTF-8. En cas d'erreur, le serveur renvoie un code HTTP ≠ 200 et `{"erreur": "message lisible en français"}`.

Le serveur lit lui-même `data/saison.json` (points des joueurs) et `cartes/catalogue.json` sur GitHub Pages. Les boosters gagnés ne peuvent donc pas être falsifiés côté navigateur.

## Règles
- **Boosters gagnés** = total des points du joueur au championnat (barème du championnat, points forcés compris). 1 point = 1 booster.
- **Booster** = 5 cartes. Chaque carte est tirée d'abord par rareté (`poids` dans `catalogue.raretes`, total 100), puis uniformément parmi les cartes de cette rareté. La 5e carte est au minimum `catalogue.derniereCarteMin` (« peu_commune »).
- **Doublon** : une carte déjà possédée est recyclée automatiquement en `fragments` (valeur selon sa rareté). On ne garde jamais deux fois la même carte.
- **Fabrication** : une carte manquante coûte `cout` fragments (selon sa rareté).

## Appels

### `GET api.php?action=etat` — public
```json
{
  "joueurs": [
    {"id": "joueur1", "nom": "Valentin", "compte": true, "points": 12,
     "boostersGagnes": 12, "boostersOuverts": 5, "boostersDispo": 7,
     "fragments": 34, "cartes": ["michael_schumacher--ferrari", "..."], "nbCartes": 23}
  ],
  "fil": [{"joueur": "joueur2", "carte": "alonso--renault", "date": "2026-10-21T22:14:03+02:00", "fabriquee": false}],
  "totalCartes": 302
}
```
`compte` = le joueur a déjà choisi son mot de passe. `fil` = les 30 dernières cartes Épique ou mieux obtenues (la plus récente en premier).

### `POST api.php?action=connexion`
Corps : `{"nom": "Valentin", "motDePasse": "…"}`. Si le joueur n'a pas encore de mot de passe, celui-ci est enregistré (4 caractères minimum).
Réponse : `{"jeton": "…", "joueur": "joueur1", "nom": "Valentin", "premiereConnexion": true}`.
Erreurs : 404 nom inconnu, 401 mauvais mot de passe, 429 trop d'essais.

### `POST api.php?action=ouvrir`
Corps : `{"jeton": "…", "nombre": 1}` (1 à 100, plafonné aux boosters disponibles).
Réponse :
```json
{"boosters": [[{"carte": "id", "nouvelle": true, "fragments": 0}, "… 5 cartes"]],
 "fragments": 40, "boostersDispo": 6}
```
`fragments` (par carte) = fragments gagnés si c'était un doublon (0 sinon). Erreurs : 401 jeton invalide, 409 aucun booster disponible.

### `POST api.php?action=fabriquer`
Corps : `{"jeton": "…", "carte": "id"}`. Réponse : `{"carte": "id", "fragments": 12}`.
Erreurs : 401, 404 carte inconnue, 409 déjà possédée ou fragments insuffisants.

### `POST api.php?action=deconnexion`
Corps : `{"jeton": "…"}`. Réponse : `{"ok": true}`.

### `POST api.php?action=reinitialiser` — réservé à Valentin
Corps : `{"cle": "<CLE_ADMIN de config.php>", "nom": "Joris"}`. Efface le mot de passe (la collection est conservée). Le joueur en choisira un nouveau à sa prochaine connexion.

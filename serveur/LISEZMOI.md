# Installer le serveur des cartes sur Hostinger

À faire une seule fois (environ 5 minutes).

## 1. Vérifier la version de PHP
hPanel → ton site → **Avancé → Configuration PHP** : choisis **PHP 8.2 ou plus récent**.

## 2. Déposer les fichiers
hPanel → ton site → **Fichiers → Gestionnaire de fichiers** → ouvre `public_html` :

1. Crée un dossier `f1-cartes`.
2. Envoie dedans, depuis `C:\Users\Valentin\F1-Championnat\serveur\` :
   - `api.php`
   - `config.php` (il contient ta clé admin : ne le partage pas)
   - le dossier `donnees` avec ses deux fichiers `.htaccess` et `index.html`

   Les fichiers qui commencent par un point (`.htaccess`) sont parfois masqués dans l'explorateur Windows. Vérifie qu'il est bien envoyé.

Tu dois obtenir :
```
public_html/f1-cartes/api.php
public_html/f1-cartes/config.php
public_html/f1-cartes/donnees/.htaccess
public_html/f1-cartes/donnees/index.html
```

## 3. Tester
- `https://TON-DOMAINE/f1-cartes/api.php?action=etat` doit afficher du texte qui commence par `{"joueurs":[`.
- `https://TON-DOMAINE/f1-cartes/donnees/etat.json` doit afficher une erreur 403 (accès interdit). C'est voulu : personne ne peut lire les données des joueurs.

Envoie ensuite l'adresse de `api.php` à Claude, qui la branche sur la page Cartes.

## Mot de passe oublié
Un joueur qui a oublié son mot de passe peut être réinitialisé avec la clé `CLE_ADMIN` de `config.php`. Sa collection est conservée, et il choisira un nouveau mot de passe à sa prochaine connexion.

## Mise à jour
Si `api.php` change, renvoie simplement ce fichier : les collections (`donnees/etat.json`) ne sont pas touchées.

Les boosters offerts à l'heure demandent la dernière version de `api.php`. Pour vérifier qu'elle est en place, ouvre `https://TON-DOMAINE/f1-cartes/api.php?action=etat` : chaque joueur doit avoir un bloc `"offerts"` (sauf si tu as désactivé les boosters offerts dans l'admin : 0 minute). Tant que l'ancienne version est en ligne, la page n'affiche simplement rien à ce sujet.

Les cartes Mythiques et les pronostics demandent eux aussi la dernière version de `api.php`. Pour vérifier, ouvre `https://TON-DOMAINE/f1-cartes/api.php?action=etat` : la réponse doit contenir un bloc `"pronos"` et, pour chaque joueur, `"boostersPronos"`. Tant que l'ancienne version est en ligne, l'onglet *Pronostics* reste caché.

Pour que les pronostics se ferment tout seuls au départ d'une course, l'enregistreur (sur ton PC) appelle ce serveur avec la clé `CLE_ADMIN` de `config.php` : le fichier `serveur/config.php` doit donc aussi être présent sur le PC de l'enregistreur, avec la même clé que sur Hostinger. Sinon, l'enregistreur le dit dans son journal et tu fermes les pronostics à la main dans l'admin (*Cartes → Pronostics du GP*).

## Sauvegarde des données
Les collections sont dans `donnees/etat.json`. Avant chaque modification, le serveur en garde une copie dans `donnees/etat.json.bak` (même dossier protégé). Si `etat.json` devenait illisible, le serveur reprend la copie ; si les deux le sont, il répond « fichier des données illisible » sans rien effacer. Pour tout remettre à zéro, supprime les deux fichiers. Pour vérifier que la sauvegarde fonctionne, regarde que `etat.json.bak` apparaît dans `donnees` après la première connexion d'un joueur.

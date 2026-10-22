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
Un joueur qui a oublié son mot de passe peut être réinitialisé avec la clé `CLE_ADMIN` de `config.php` (dans l'admin : *Cartes → Comptes des joueurs*, pilotes comme spectateurs). Sa collection est conservée, et le premier mot de passe saisi à sa prochaine connexion devient le nouveau : préviens la personne de se connecter tout de suite.

## Spectateurs
Des joueurs extérieurs au championnat peuvent créer eux-mêmes un compte sur la page Cartes (un pseudo et un mot de passe, bouton « Créer un compte spectateur »). Ils ne marquent pas de points : ils ont leur collection, un booster offert par heure (comme les pilotes) et des pronostics, et apparaissent dans une section à part de l'onglet *Collections*, dans le fil des grosses cartes et dans le classement des pronostics.

Réglages dans l'admin (*Cartes → Économie*) : nombre maximum de comptes (30 par défaut, 100 au plus ; **0 ferme les inscriptions**, les comptes existants restent) et boosters offerts à l'inscription (1 par défaut). Contre les robots, le serveur refuse plus de 5 inscriptions par heure depuis une même connexion et plus de 20 par heure au total ; l'adresse IP n'est jamais enregistrée en clair. Si ton hébergeur place un CDN devant le site, tous les visiteurs ont alors la même adresse côté serveur et la limite « par connexion » joue comme une limite de 5 inscriptions par heure pour tout le monde : c'est suffisant pour quelques spectateurs, sinon dis-le-moi. Pour supprimer un compte indésirable : *Cartes → Comptes des joueurs → Spectateurs → Supprimer* (collection, paris et tirages effacés, c'est définitif).

## Mise à jour
Si `api.php` change, renvoie simplement ce fichier : les collections (`donnees/etat.json`) ne sont pas touchées.

Les boosters offerts à l'heure demandent la dernière version de `api.php`. Pour vérifier qu'elle est en place, ouvre `https://TON-DOMAINE/f1-cartes/api.php?action=etat` : chaque joueur doit avoir un bloc `"offerts"` (sauf si tu as désactivé les boosters offerts dans l'admin : 0 minute). Tant que l'ancienne version est en ligne, la page n'affiche simplement rien à ce sujet.

Les spectateurs demandent eux aussi la dernière version de `api.php`. Pour vérifier, la réponse de `?action=etat` doit contenir `"spectateurs"` et `"inscriptions"`. Tant que l'ancienne version est en ligne, la page n'affiche rien à ce sujet (pas de bouton d'inscription).

Les cartes Mythiques et les pronostics demandent eux aussi la dernière version de `api.php`. Pour vérifier, ouvre `https://TON-DOMAINE/f1-cartes/api.php?action=etat` : la réponse doit contenir un bloc `"pronos"` et, pour chaque joueur, `"boostersPronos"`. Tant que l'ancienne version est en ligne, l'onglet *Pronostics* reste caché.

Pour que les pronostics se ferment tout seuls au départ d'une course, l'enregistreur (sur ton PC) appelle ce serveur avec la clé `CLE_ADMIN` de `config.php` : le fichier `serveur/config.php` doit donc aussi être présent sur le PC de l'enregistreur, avec la même clé que sur Hostinger. Sinon, l'enregistreur le dit dans son journal et tu fermes les pronostics à la main dans l'admin (*Cartes → Pronostics du GP*).

## Sauvegarde des données
Les collections sont dans `donnees/etat.json`. Avant chaque modification, le serveur en garde une copie dans `donnees/etat.json.bak` (même dossier protégé). Si `etat.json` devenait illisible, le serveur reprend la copie ; si les deux le sont, il répond « fichier des données illisible » sans rien effacer. Pour tout remettre à zéro, supprime les deux fichiers. Pour vérifier que la sauvegarde fonctionne, regarde que `etat.json.bak` apparaît dans `donnees` après la première connexion d'un joueur.

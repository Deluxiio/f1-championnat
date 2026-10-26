# Championnat F1 25 entre potes

F1 25 ne permet pas de faire une carrière à 4. On joue donc des courses en ligne en partie personnalisée, et ce projet garde les résultats pour en faire un vrai championnat.

- **L'enregistreur** tourne sur le PC de l'hôte. Il écoute la télémétrie du jeu et, à chaque arrivée, enregistre le classement final complet (joueurs et IA).
- **La page publique** (GitHub Pages) affiche le classement pilotes et constructeurs, l'évolution, les duels, les stats et le calendrier. Elle est mise à jour automatiquement après chaque GP.
- **L'admin locale** (http://localhost:8025) sert à vérifier que tout le monde est reconnu, à corriger un résultat et à ajouter une course à la main.

## Réglages à faire une fois dans F1 25

Dans *Options de jeu → Paramètres → Télémétrie* :

| Réglage | Valeur |
|---|---|
| Télémétrie UDP | Activée |
| Mode diffusion UDP | Désactivé |
| Adresse IP UDP | 127.0.0.1 |
| Port UDP | 20777 |
| Fréquence d'envoi UDP | 20 Hz (n'importe laquelle convient) |
| Format UDP | 2025 |

Seul le PC qui fait tourner l'enregistreur a besoin de ces réglages. Le jeu envoie le classement de **toutes** les voitures, donc les autres joueurs n'ont rien à installer.

## Une soirée de course

1. Double-clique sur **Lancer.bat**. Une fenêtre noire s'ouvre avec l'admin dans le navigateur. **Laisse la fenêtre ouverte** pendant toute la soirée.
2. Dans le lobby, regarde le bloc *Enregistreur* de l'admin : les pseudos des joueurs humains doivent apparaître en vert avec le bon nom. Si un pseudo est en orange (« non reconnu »), associe-le avec le menu à côté. C'est retenu pour les fois suivantes.
3. Courez. À l'arrivée, la course est enregistrée et publiée toute seule. La page publique se met à jour 1 à 2 minutes plus tard.
4. Si besoin, corrige dans l'admin (*Courses → Modifier*) : ordre, abandon, pénalité, points forcés, etc. Puis *Enregistrer et publier*.

Seules les **courses en ligne** sont enregistrées. Les essais, qualifs et courses hors ligne sont ignorés.

### Si le classement final n'a pas été reçu

C'est le cas si le jeu a planté, si l'hôte a été déconnecté ou si l'enregistreur n'était pas lancé :

- *+ Depuis la dernière course captée* reprend les dernières positions connues pendant la course. Tu n'as plus qu'à vérifier.
- *+ Course manuelle* reprend les pilotes de la course précédente. Tu les remets dans l'ordre d'arrivée.

### Pseudo « Player » ou nom générique

Selon les options en ligne du jeu, un joueur peut apparaître sous un nom générique. Le plus simple est d'activer l'affichage des noms des joueurs en ligne dans les options du jeu. Sinon, associe le nom à la main dans l'admin.

### Échec de la publication

La course reste enregistrée sur le PC, seule la mise en ligne a échoué. La cause la plus courante : GitHub a reçu des changements que le PC n'a pas encore (une mise à jour du site faite depuis ailleurs), et il refuse alors le push. L'enregistreur les récupère tout seul puis republie, il n'y a rien à faire. Si le message revient :

- **« en conflit avec celle de ce PC »** : GitHub et le PC ont chacun modifié la saison. Rien n'est perdu (la saison du PC est intacte), mais les deux versions sont à fusionner à la main : demande de l'aide plutôt que de forcer le push.
- **Autre message** (réseau, droits GitHub) : vérifie la connexion, puis clique sur *Enregistrer et publier* dans l'admin pour réessayer.
- **Si ça bloque quand même**, ouvre un terminal dans le dossier du projet et tape `git pull --rebase --autostash`, puis `git push`. Si `git pull` a changé des fichiers de `enregistreur/`, ferme la fenêtre noire et relance **Lancer.bat** pour prendre la nouvelle version.

## Points et classements

- Barème officiel : 25-18-15-12-10-8-6-4-2-1 pour le top 10, pas de point pour le meilleur tour.
- Les égalités se départagent au nombre de victoires, puis de 2es places, etc.
- Le classement constructeurs additionne les points des deux voitures de chaque écurie, joueurs et IA compris.
- Le barème, le titre et le calendrier sont dans `docs/data/saison.json`. Les joueurs se modifient depuis l'admin (*Réglages*).

## Jeu de cartes

La page **Cartes** (`docs/cartes/`) est un jeu de collection : 1 point au championnat = 1 booster de 5 cartes.

- **La collection** compte environ 710 cartes de vrais pilotes, une par couple pilote × écurie depuis 1980, plus 4 cartes Mythiques : les vôtres.
- **La rareté** dépend de ce que le pilote a fait dans cette écurie : Icône (3 titres ou plus), Légendaire (titre), Épique (victoire), Rare (podium), Peu commune (points) ou Commune.
- **Les cartes Mythiques** sont les cartes des 4 potes (casque aux couleurs de chacun, ou sa photo quand il en a donné une ; numéro de course). C'est la rareté au-dessus de tout : on ne les trouve que dans les boosters, environ 1 booster sur 100 en contient une (jamais plus d'une), et elles ne se fabriquent pas. Leurs chiffres (victoires, podiums, points, GP, note) et l'écurie affichée (celle qu'ils pilotent dans le jeu, relevée dans `saison.json` ; « La bande » tant qu'ils n'ont pas couru) suivent le championnat en direct. Tant qu'il manque une Mythique à un joueur, c'est une nouvelle qui sort en premier ; un doublon vaut 1000 fragments.
- **Les doublons** sont recyclés en fragments, qui servent à fabriquer les cartes manquantes.
- **Les spectateurs** : des joueurs extérieurs au championnat créent leur compte sur la page Cartes avec un simple pseudo et un mot de passe. Ils ne marquent pas de points et n'apparaissent pas au classement, mais ils collectionnent, reçoivent 1 booster offert par heure comme les pilotes et font des pronostics aux mêmes cotes. On les retrouve dans une section « Spectateurs » de l'onglet *Collections*, dans le fil des grosses cartes et dans le classement des pronostics. Garde-fous : 30 comptes au plus (réglable, 0 ferme les inscriptions) et des limites contre les robots ; l'admin peut réinitialiser un mot de passe ou supprimer un compte.
- **Les pronostics** (onglet *Pronostics*) : avant chaque GP, chacun devine **le meilleur d'entre vous** et **l'ordre d'arrivée** de la bande, sans rien miser (on ne perd jamais rien). Un pari juste rapporte des boosters : boosters de base × cote, les cotes étant calculées à l'ouverture du GP d'après les points au championnat et figées jusqu'à la course. Le GP suivant du calendrier s'ouvre tout seul dès que la course précédente est enregistrée, les pronostics **se ferment au départ de la course** (l'enregistreur prévient le serveur, il lui faut `docs/cartes/config.js` et `serveur/config.php` sur le PC) et se règlent tout seuls après. Les paris restent secrets jusqu'à la fermeture. Une course marquée « À vérifier » n'est réglée qu'une fois corrigée dans l'admin. Un GP annulé ou fermé trop tôt se gère depuis l'admin (*Cartes → Pronostics du GP*).
- **Les boosters offerts** : en plus de ceux gagnés avec les points, chaque joueur reçoit 1 booster par heure, même sans jouer. Ils s'accumulent dans un stock de 10 au maximum (quand le stock est plein, le compteur s'arrête jusqu'à la prochaine ouverture) et s'ouvrent avant les boosters gagnés avec les points. Le délai et le stock maximum se règlent dans l'admin (*Cartes → Économie*) ; 0 minute désactive le système.

Fichiers :
- `outils/catalogue.py` régénère `docs/cartes/catalogue.json` à partir des résultats officiels (API Jolpica, avec un cache local).
- `outils/photos.py` récupère la photo principale de chaque pilote sur Wikipédia. Il la garde seulement si elle est sous licence libre sur Wikimedia Commons, et note l'auteur et la licence pour les crédits affichés sur le site. Les pilotes sans photo libre gardent leur casque dessiné. Lance-le avant `catalogue.py`.
- `outils/photo_ami.py` met la photo d'un pote sur sa carte Mythique : `py outils/photo_ami.py joueur2 photo.png`. L'image est réduite en JPEG (720 px de large) dans `docs/cartes/photos/`, déclarée dans `outils/photos-amis.json` (que `photos.py` et `catalogue.py` respectent) et inscrite dans le catalogue sans le régénérer ; l'originale n'est pas gardée dans le dépôt. Le format idéal est un paysage 4:3 (800 × 600) avec le visage dans la moitié haute. Sans argument il liste les potes et leur photo, `--retirer` rend son casque à la carte et `--gamma 0.75` éclaircit une photo très sombre.
- `serveur/` contient le serveur PHP (comptes, boosters, fragments) installé sur Hostinger. Voir `serveur/LISEZMOI.md` pour l'installation et `serveur/API.md` pour le fonctionnement.
- Tant que `docs/cartes/config.js` ne contient pas l'adresse du serveur, la page tourne en **mode démo** : rien n'y est conservé.

Le bloc **Cartes** de l'admin locale (lien « Cartes ↓ » en haut) permet de régler :
- l'économie : points pour 1 booster, cartes par booster, chances de chaque rareté (dont la chance de Mythique par booster), valeur des doublons et prix de fabrication ;
- les pronostics : boosters de base de chaque pari, gain maximum, lissage des cotes (0 aux deux paris = désactivés), et le GP en cours (fermer, rouvrir, annuler) ;
- les spectateurs : nombre maximum de comptes (0 = inscriptions fermées) et boosters offerts à l'inscription ;
- des boosters bonus (ou retirés) par joueur ;
- chaque carte du catalogue : rareté, note, prix propre et phrase ;
- les comptes des joueurs et des spectateurs, avec la réinitialisation d'un mot de passe oublié et la suppression d'un spectateur.

Le bouton *Enregistrer et publier* met le site à jour, et le serveur applique les changements sous 5 à 15 minutes.

## Réglages de l'enregistreur

`enregistreur/config.json` est créé au premier lancement :

| Clé | Rôle |
|---|---|
| `ecoute` | IP et port d'écoute de la télémétrie |
| `portAdmin` | port de l'admin locale (8025) |
| `renvoyerVers` | pour utiliser une autre appli de télémétrie en même temps, ex. `["127.0.0.1:20778"]` |
| `publicationAuto` | publier sur GitHub après chaque course |
| `seulementEnLigne` | ignorer les courses hors ligne |
| `urlPublique` | lien vers la page publique, affiché dans l'admin |

## Tester sans le jeu

```
cd enregistreur
py simulateur.py --circuit 0 --humains "Pseudo1,Pseudo2,Pseudo3,Pseudo4"
```

Le simulateur envoie une vraie séance au format F1 25 à l'enregistreur. Pense à supprimer les courses de test dans l'admin.

## Organisation

```
Lancer.bat            lance l'enregistreur et ouvre l'admin
enregistreur/         écoute UDP, admin locale, publication git (Python, sans dépendance)
admin/                pages de l'admin locale
docs/                 page publique (GitHub Pages)
docs/data/saison.json toutes les données du championnat
```

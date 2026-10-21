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

## Points et classements

- Barème officiel : 25-18-15-12-10-8-6-4-2-1 pour le top 10, pas de point pour le meilleur tour.
- Les égalités se départagent au nombre de victoires, puis de 2es places, etc.
- Le classement constructeurs additionne les points des deux voitures de chaque écurie, joueurs et IA compris.
- Le barème, le titre et le calendrier sont dans `docs/data/saison.json`. Les joueurs se modifient depuis l'admin (*Réglages*).

## Jeu de cartes

La page **Cartes** (`docs/cartes/`) est un jeu de collection : 1 point au championnat = 1 booster de 5 cartes.

- **La collection** compte 302 cartes, une par couple pilote × écurie depuis 2000.
- **La rareté** dépend de ce que le pilote a fait dans cette écurie : Icône (3 titres ou plus), Légendaire (titre), Épique (victoire), Rare (podium), Peu commune (points) ou Commune.
- **Les doublons** sont recyclés en fragments, qui servent à fabriquer les cartes manquantes.

Fichiers :
- `outils/catalogue.py` régénère `docs/cartes/catalogue.json` à partir des résultats officiels (API Jolpica, avec un cache local).
- `serveur/` contient le serveur PHP (comptes, boosters, fragments) installé sur Hostinger. Voir `serveur/LISEZMOI.md` pour l'installation et `serveur/API.md` pour le fonctionnement.
- Tant que `docs/cartes/config.js` ne contient pas l'adresse du serveur, la page tourne en **mode démo** : rien n'y est conservé.

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

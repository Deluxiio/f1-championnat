"""Met (ou retire) la photo d'un pote sur sa carte Mythique.

La photo est réduite et compressée en JPEG dans docs/cartes/photos/<joueur>.jpg, déclarée dans outils/photos-amis.json
(que photos.py et catalogue.py respectent) et inscrite dans docs/cartes/catalogue.json sans régénérer le catalogue.
L'image d'origine n'est pas copiée dans le dépôt. Format idéal : paysage 4:3 (800 x 600), visage dans la moitié haute.

    py outils/photo_ami.py                                 liste les potes et leur photo
    py outils/photo_ami.py joueur2 photo.png               met la photo (remplace l'ancienne)
    py outils/photo_ami.py joueur4 photo.png --gamma 0.75  l'éclaircit un peu (photo très sombre ; 1 = inchangée)
    py outils/photo_ami.py joueur2 --retirer               rend son casque dessiné à la carte
"""
import argparse
import io
import json
import sys
from pathlib import Path

from PIL import Image, UnidentifiedImageError

import photos

LARGEUR = 720  # la fenêtre de la carte fait ~270 px de large : 720 couvre les écrans 2x avec de la marge
QUALITE = 82


def lire(chemin):
    return json.loads(chemin.read_text(encoding="utf-8")) if chemin.exists() else {}


def ecrire(chemin, donnees):
    chemin.write_text(json.dumps(donnees, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")


def main(argv=None):
    parseur = argparse.ArgumentParser(description="Photo d'un pote sur sa carte Mythique.")
    parseur.add_argument("joueur", nargs="?", help="identifiant du pote (joueur1, joueur2…) ; sans lui : la liste")
    parseur.add_argument("image", nargs="?", type=Path, help="image d'origine (png, jpg, webp)")
    parseur.add_argument("--gamma", type=float, default=1.0, help="< 1 éclaircit les tons sombres (défaut 1 : inchangée)")
    parseur.add_argument("--retirer", action="store_true", help="retire la photo : la carte retrouve son casque")
    args = parseur.parse_args(argv)
    if not 0.3 <= args.gamma <= 3:
        parseur.error("--gamma doit être compris entre 0.3 et 3")

    catalogue = json.loads(photos.CATALOGUE.read_text(encoding="utf-8"))
    potes = {c["ami"]: f"{c['prenom']} {c['nom']}" for c in catalogue["cartes"] if c.get("ami")}
    manifeste = lire(photos.AMIS)

    if not args.joueur:
        for pid, nom in potes.items():
            print(f"{pid}  {nom:<24}", manifeste[pid]["photo"] if pid in manifeste else "pas de photo (casque dessiné)")
        return 0
    if args.joueur not in potes:
        print(f"« {args.joueur} » n'est pas un pote du championnat. Possibles : {', '.join(potes)}", file=sys.stderr)
        return 1
    pid, cible = args.joueur, photos.DOSSIER / f"{args.joueur}.jpg"

    if args.retirer:
        manifeste.pop(pid, None)
        cible.unlink(missing_ok=True)
        resume = f"{pid} ({potes[pid]}) : photo retirée, le casque est rendu à la carte"
    else:
        if not args.image:
            print("Il faut l'image à mettre, ou --retirer.", file=sys.stderr)
            return 1
        try:
            jpeg = photos.optimiser(args.image.read_bytes(), LARGEUR, QUALITE, args.gamma)
        except (OSError, UnidentifiedImageError) as e:
            print(f"Image illisible ({args.image}) : {e}", file=sys.stderr)
            return 1
        largeur, hauteur = Image.open(io.BytesIO(jpeg)).size
        cible.parent.mkdir(parents=True, exist_ok=True)
        cible.write_bytes(jpeg)
        manifeste[pid] = {"photo": f"photos/{cible.name}", "personnelle": True}
        resume = f"{pid} ({potes[pid]}) : {manifeste[pid]['photo']}, {largeur} x {hauteur}, {len(jpeg) / 1024:.0f} Ko"
        if not 1.2 <= largeur / hauteur <= 1.5:
            print(f"Attention : format {largeur} x {hauteur}. La carte montre une fenêtre paysage (~4:3) : "
                  "un format paysage, avec le visage dans la moitié haute, rend mieux.", file=sys.stderr)

    ecrire(photos.AMIS, dict(sorted(manifeste.items())))
    pilotes = dict(catalogue.get("pilotes", {}))
    if pid in manifeste:
        pilotes[pid] = manifeste[pid]
    else:
        pilotes.pop(pid, None)
    catalogue["pilotes"] = dict(sorted(pilotes.items()))  # même ordre que catalogue.py
    ecrire(photos.CATALOGUE, catalogue)
    print(resume)
    return 0


if __name__ == "__main__":
    sys.exit(main())

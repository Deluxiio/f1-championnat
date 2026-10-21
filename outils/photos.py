"""Récupère une photo libre de droits (Wikimedia Commons) pour chaque pilote du catalogue.

Pour chaque pilote : image principale de sa page Wikipédia (lien fourni par l'API Jolpica),
gardée uniquement si elle est hébergée sur Commons (licence libre), avec auteur et licence
pour les crédits. Les vignettes vont dans docs/cartes/photos/, les crédits dans outils/photos.json.
Les pilotes sans photo libre gardent leur casque dessiné.

    py outils/photos.py
"""
import html
import io
import json
import re
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

from PIL import Image

RACINE = Path(__file__).resolve().parent.parent
CATALOGUE = RACINE / "docs" / "cartes" / "catalogue.json"
DOSSIER = RACINE / "docs" / "cartes" / "photos"
CREDITS = Path(__file__).resolve().parent / "photos.json"
CACHE = Path(__file__).resolve().parent / "cache"
AGENT = "F1ChampionnatEntreAmis/1.0 (https://github.com/Deluxiio/f1-championnat)"
LARGEUR = 360


def requete(url, binaire=False):
    for essai in range(5):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": AGENT})
            with urllib.request.urlopen(req, timeout=30) as r:
                donnees = r.read()
            time.sleep(0.15)
            return donnees if binaire else json.loads(donnees)
        except Exception as e:
            print(f"  nouvel essai ({e})", file=sys.stderr)
            time.sleep(3 * (essai + 1))
    raise RuntimeError(url)


def optimiser(octets):
    """JPEG léger : 360 px de large maximum, qualité 80, sans métadonnées, transparence sur fond sombre."""
    image = Image.open(io.BytesIO(octets))
    if image.mode in ("RGBA", "LA", "P"):
        image = image.convert("RGBA")
        fond = Image.new("RGB", image.size, (21, 21, 30))
        fond.paste(image, mask=image.split()[-1])
        image = fond
    else:
        image = image.convert("RGB")
    if image.width > LARGEUR:
        image = image.resize((LARGEUR, round(image.height * LARGEUR / image.width)), Image.LANCZOS)
    sortie = io.BytesIO()
    image.save(sortie, "JPEG", quality=80, optimize=True, progressive=True)
    return sortie.getvalue()


def texte_brut(valeur):
    return re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", valeur or ""))).strip()


def liens_wikipedia():
    """driverId -> titre de la page Wikipédia anglaise, d'après le cache de l'API Jolpica."""
    liens = {}
    for fichier in CACHE.glob("*_results.json*"):
        for course in json.loads(fichier.read_text(encoding="utf-8"))["MRData"]["RaceTable"]["Races"]:
            for r in course.get("Results", []):
                url = r["Driver"].get("url", "")
                if "wikipedia.org/wiki/" in url:
                    liens[r["Driver"]["driverId"]] = urllib.parse.unquote(url.split("/wiki/", 1)[1]).replace("_", " ")
    return liens


def main():
    catalogue = json.loads(CATALOGUE.read_text(encoding="utf-8"))
    pilotes = sorted({c["pilote"] for c in catalogue["cartes"]})
    liens = liens_wikipedia()
    anciens = json.loads(CREDITS.read_text(encoding="utf-8")) if CREDITS.exists() else {}
    DOSSIER.mkdir(parents=True, exist_ok=True)

    # 1. Image principale de chaque page Wikipédia (50 titres par appel)
    titres = {pid: liens[pid] for pid in pilotes if pid in liens}
    image_de_titre = {}
    liste = list(titres.values())
    for i in range(0, len(liste), 50):
        lot = liste[i:i + 50]
        url = ("https://en.wikipedia.org/w/api.php?action=query&format=json&redirects=1&prop=pageimages"
               "&piprop=name&titles=" + urllib.parse.quote("|".join(lot)))
        d = requete(url)["query"]
        renvois = {x["from"]: x["to"] for x in d.get("normalized", []) + d.get("redirects", [])}
        par_titre = {p["title"]: p.get("pageimage") for p in d.get("pages", {}).values()}
        for t in lot:
            final = t
            while final in renvois:
                final = renvois[final]
            image_de_titre[t] = par_titre.get(final)

    # 2. Licence et vignette sur Commons (les images absentes de Commons ne sont pas libres : ignorées)
    fichiers = sorted({f for f in image_de_titre.values() if f})
    infos = {}
    for i in range(0, len(fichiers), 50):
        lot = fichiers[i:i + 50]
        url = ("https://commons.wikimedia.org/w/api.php?action=query&format=json&prop=imageinfo"
               f"&iiprop=url|extmetadata&iiurlwidth={LARGEUR}&titles=" + urllib.parse.quote("|".join("File:" + f for f in lot)))
        d = requete(url)["query"]
        renvois = {x["to"]: x["from"] for x in d.get("normalized", [])}
        for p in d.get("pages", {}).values():
            if "missing" in p or not p.get("imageinfo"):
                continue
            ii = p["imageinfo"][0]
            meta = ii.get("extmetadata", {})
            nom = renvois.get(p["title"], p["title"]).removeprefix("File:")
            infos[nom] = {
                "vignette": ii.get("thumburl"), "source": ii.get("descriptionurl"),
                "auteur": texte_brut(meta.get("Artist", {}).get("value")) or "Auteur inconnu",
                "licence": texte_brut(meta.get("LicenseShortName", {}).get("value")) or "Licence libre",
                "lienLicence": meta.get("LicenseUrl", {}).get("value", ""),
            }

    # 3. Téléchargement des vignettes
    credits, sans = {}, []
    for pid in pilotes:
        fichier = image_de_titre.get(titres.get(pid))
        info = infos.get(fichier) if fichier else None
        if not info or not info["vignette"]:
            sans.append(pid)
            continue
        ext = Path(urllib.parse.urlparse(info["vignette"]).path).suffix.lower()
        if ext not in (".jpg", ".jpeg", ".png", ".webp"):
            sans.append(pid)
            continue
        cible = DOSSIER / f"{pid}.jpg"
        ancien = anciens.get(pid, {})
        if not (cible.exists() and ancien.get("source") == info["source"] and ancien.get("optimisee")):
            cible.write_bytes(optimiser(requete(info["vignette"], binaire=True)))
        credits[pid] = {"photo": f"photos/{cible.name}", "auteur": info["auteur"], "licence": info["licence"],
                        "lienLicence": info["lienLicence"], "source": info["source"], "optimisee": True}
    for f in DOSSIER.iterdir():  # photos devenues inutiles (et anciens .png)
        if f.stem not in credits or f.suffix != ".jpg":
            f.unlink()
    CREDITS.write_text(json.dumps(credits, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    taille = sum(f.stat().st_size for f in DOSSIER.iterdir()) / 1e6
    print(f"{len(credits)}/{len(pilotes)} pilotes avec photo ({taille:.1f} Mo). Sans photo libre : {len(sans)}")
    print("Exemples sans photo :", sans[:25])


if __name__ == "__main__":
    main()

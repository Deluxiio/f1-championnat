"""Génère docs/cartes/catalogue.json : une carte par couple pilote × écurie depuis 1980.

Les stats de chaque carte sont celles du pilote dans cette écurie (toutes saisons confondues,
y compris avant 1980 pour les passages déjà commencés). Source : API Jolpica (ex-Ergast).
Les réponses sont mises en cache dans outils/cache/ : relancer le script ne refait pas d'appels.

    py outils/catalogue.py
"""
import json
import math
import re
import sys
import time
import urllib.request
from collections import defaultdict
from datetime import date
from pathlib import Path

RACINE = Path(__file__).resolve().parent.parent
CACHE = Path(__file__).resolve().parent / "cache"
SORTIE = RACINE / "docs" / "cartes" / "catalogue.json"
SAISON = RACINE / "docs" / "data" / "saison.json"  # les joueurs du championnat, pour leurs cartes Mythiques
PHOTOS = Path(__file__).resolve().parent / "photos.json"  # produit par outils/photos.py
API = "https://api.jolpi.ca/ergast/f1"
PREMIERE_SAISON_CARTES = 1980
PREMIERE_SAISON_STATS = 1970  # couvre les passages dans une écurie déjà commencés en 1980 (Laffite chez Ligier depuis 1976…)
DERNIERE_SAISON = date.today().year
BAREME_ACTUEL = [25, 18, 15, 12, 10, 8, 6, 4, 2, 1]

# Ordre du plus rare au plus courant. poids = chances de tirage, fragments = valeur d'un doublon,
# cout = fragments pour fabriquer la carte. Lus aussi par le serveur et la page.
# Mythique = les cartes des joueurs du championnat : poids 0 (jamais tirée avec les poids, elle a son propre tirage réglé par
# chanceMythiqueParBooster) et coût énorme (elle ne se fabrique pas, même avec une ancienne version du serveur).
RARETES = [
    {"id": "mythique", "nom": "Mythique", "regle": "Carte d'un des potes du championnat (boosters uniquement)", "poids": 0, "fragments": 1000, "cout": 1000000, "notes": [88, 99]},
    {"id": "icone", "nom": "Icône", "regle": "Au moins 3 titres avec cette écurie", "poids": 1, "fragments": 400, "cout": 3200, "notes": [96, 99]},
    {"id": "legendaire", "nom": "Légendaire", "regle": "Champion du monde avec cette écurie", "poids": 3, "fragments": 100, "cout": 800, "notes": [90, 95]},
    {"id": "epique", "nom": "Épique", "regle": "Au moins une victoire avec cette écurie", "poids": 7, "fragments": 20, "cout": 160, "notes": [81, 89]},
    {"id": "rare", "nom": "Rare", "regle": "Au moins un podium avec cette écurie", "poids": 14, "fragments": 5, "cout": 40, "notes": [73, 80]},
    {"id": "peu_commune", "nom": "Peu commune", "regle": "A marqué des points avec cette écurie", "poids": 25, "fragments": 2, "cout": 16, "notes": [63, 72]},
    {"id": "commune", "nom": "Commune", "regle": "Aucun point avec cette écurie", "poids": 50, "fragments": 1, "cout": 8, "notes": [50, 62]},
]

# Couleurs de livrée (approximatives) : [principale, secondaire, accent]
COULEURS = {
    "ferrari": ["#DC0000", "#FFD200", "#111111"], "mclaren": ["#FF8000", "#47C7FC", "#111111"],
    "williams": ["#1868DB", "#FFFFFF", "#0A1E3F"], "benetton": ["#00A3E0", "#FFD200", "#00843D"],
    "jordan": ["#FFD200", "#111111", "#E10600"], "sauber": ["#01C00E", "#111111", "#FFFFFF"],
    "prost": ["#1F3F8F", "#FFFFFF", "#E10600"], "arrows": ["#F58220", "#111111", "#FFFFFF"],
    "minardi": ["#111111", "#FFD200", "#FFFFFF"], "jaguar": ["#0B5A2A", "#FFFFFF", "#C9A227"],
    "bar": ["#FFFFFF", "#E10600", "#1F3F8F"], "toyota": ["#FFFFFF", "#E10600", "#111111"],
    "renault": ["#0050A0", "#FFD200", "#FFFFFF"], "red_bull": ["#1E2A5A", "#E10600", "#FFD200"],
    "bmw_sauber": ["#FFFFFF", "#0044AA", "#E10600"], "honda": ["#FFFFFF", "#E10600", "#2B6CB0"],
    "super_aguri": ["#E10600", "#FFFFFF", "#111111"], "mf1": ["#E10600", "#FFFFFF", "#111111"],
    "spyker_mf1": ["#FF6600", "#C0C0C0", "#111111"], "spyker": ["#FF6600", "#C0C0C0", "#111111"],
    "toro_rosso": ["#1E2A5A", "#E10600", "#C0C0C0"], "force_india": ["#FF6600", "#138808", "#FFFFFF"],
    "brawn": ["#FFFFFF", "#D4F000", "#111111"], "mercedes": ["#C0C0C0", "#00D2BE", "#111111"],
    "virgin": ["#111111", "#E10600", "#FFFFFF"], "lotus_racing": ["#0B5A2A", "#FFD200", "#FFFFFF"],
    "hrt": ["#5A5A5A", "#E10600", "#FFFFFF"], "team_lotus": ["#0B5A2A", "#FFD200", "#FFFFFF"],
    "caterham": ["#0B5A2A", "#FFD200", "#FFFFFF"], "marussia": ["#E10600", "#111111", "#FFFFFF"],
    "lotus_f1": ["#111111", "#C9A227", "#E10600"], "manor": ["#E10600", "#1F3F8F", "#FFFFFF"],
    "haas": ["#B6BABD", "#E10600", "#111111"], "racing_point": ["#F596C8", "#1F3F8F", "#FFFFFF"],
    "alphatauri": ["#FFFFFF", "#1E2A5A", "#C0C0C0"], "alpine": ["#0093CC", "#F596C8", "#FFFFFF"],
    "aston_martin": ["#00594F", "#CEDC00", "#FFFFFF"], "alfa": ["#9B0000", "#FFFFFF", "#111111"],
    "rb": ["#1634CB", "#FFFFFF", "#E10600"], "cadillac": ["#111111", "#C0C0C0", "#FFFFFF"],
    "audi": ["#C0C0C0", "#E10600", "#111111"], "footwork": ["#F58220", "#111111", "#FFFFFF"],
    "stewart": ["#FFFFFF", "#111111", "#E10600"], "tyrrell": ["#1F3F8F", "#FFFFFF", "#111111"],
    "ligier": ["#1F3F8F", "#FFFFFF", "#E10600"], "lotus": ["#0B5A2A", "#FFD200", "#FFFFFF"],
    # Écuries des années 1970 à 1990
    "ags": ["#FFFFFF", "#1F3F8F", "#E10600"], "ats": ["#FFD200", "#E10600", "#111111"],
    "brabham": ["#FFFFFF", "#1F3F8F", "#E10600"], "coloni": ["#FFD200", "#1F3F8F", "#FFFFFF"],
    "dallara": ["#E10600", "#FFFFFF", "#111111"], "ensign": ["#1F3F8F", "#FFFFFF", "#E10600"],
    "eurobrun": ["#FFFFFF", "#E10600", "#111111"], "fittipaldi": ["#FFD200", "#C0C0C0", "#111111"],
    "fondmetal": ["#111111", "#FFFFFF", "#E10600"], "forti": ["#FFD200", "#1F3F8F", "#00843D"],
    "lambo": ["#E10600", "#FFFFFF", "#111111"], "larrousse": ["#1F3F8F", "#FFFFFF", "#FFD200"],
    "leyton": ["#00B2A9", "#FFFFFF", "#1F3F8F"], "lola": ["#1F3F8F", "#FFFFFF", "#E10600"],
    "march": ["#00B2A9", "#FFFFFF", "#111111"], "moda": ["#111111", "#E10600", "#FFFFFF"],
    "onyx": ["#1F3F8F", "#F596C8", "#FFFFFF"], "osella": ["#FFFFFF", "#1F3F8F", "#E10600"],
    "pacific": ["#1F3F8F", "#FFFFFF", "#00A3E0"], "ram": ["#FFFFFF", "#E10600", "#1F3F8F"],
    "rial": ["#1F3F8F", "#FFFFFF", "#111111"], "shadow": ["#111111", "#FFFFFF", "#C0C0C0"],
    "simtek": ["#6A0DAD", "#111111", "#FFFFFF"], "spirit": ["#FFFFFF", "#E10600", "#111111"],
    "theodore": ["#E10600", "#FFFFFF", "#111111"], "toleman": ["#FFFFFF", "#1F3F8F", "#E10600"],
    "zakspeed": ["#FFFFFF", "#E10600", "#111111"],
    "amis": ["#E10600", "#FFD200", "#111111"],
}

NATIONALITES = {
    "American": ("USA", "États-Unis"), "Argentine": ("ARG", "Argentine"), "Australian": ("AUS", "Australie"),
    "Austrian": ("AUT", "Autriche"), "Belgian": ("BEL", "Belgique"), "Brazilian": ("BRA", "Brésil"),
    "British": ("GBR", "Royaume-Uni"), "Canadian": ("CAN", "Canada"), "Chinese": ("CHN", "Chine"),
    "Colombian": ("COL", "Colombie"), "Czech": ("CZE", "Tchéquie"), "Danish": ("DEN", "Danemark"),
    "Dutch": ("NED", "Pays-Bas"), "Finnish": ("FIN", "Finlande"), "French": ("FRA", "France"),
    "German": ("GER", "Allemagne"), "Hungarian": ("HUN", "Hongrie"), "Indian": ("IND", "Inde"),
    "Indonesian": ("INA", "Indonésie"), "Irish": ("IRL", "Irlande"), "Italian": ("ITA", "Italie"),
    "Japanese": ("JPN", "Japon"), "Malaysian": ("MAS", "Malaisie"), "Mexican": ("MEX", "Mexique"),
    "Monegasque": ("MON", "Monaco"), "New Zealander": ("NZL", "Nouvelle-Zélande"), "Polish": ("POL", "Pologne"),
    "Portuguese": ("POR", "Portugal"), "Russian": ("RUS", "Russie"), "Spanish": ("ESP", "Espagne"),
    "Swedish": ("SWE", "Suède"), "Swiss": ("SUI", "Suisse"), "Thai": ("THA", "Thaïlande"),
    "Venezuelan": ("VEN", "Venezuela"), "Chilean": ("CHI", "Chili"), "South African": ("RSA", "Afrique du Sud"), "Argentinian": ("ARG", "Argentine"), "Estonian": ("EST", "Estonie"),
}

STATUTS_NON_PARTANT = ("qualify", "withdrew", "did not start", "excluded")

# Couleurs des cartes des potes = celles des joueurs sur le site (--j1 à --j8 de docs/style.css) : [principale, secondaire, accent]
COULEURS_AMIS = [
    ["#2A78D6", "#FFFFFF", "#0A1E3F"], ["#EB6834", "#FFD9A0", "#2A0F05"], ["#1BAF7A", "#D9FFF0", "#052A1D"],
    ["#EDA100", "#FFF1C2", "#2A1D00"], ["#E87BA4", "#FFE0EC", "#3A1022"], ["#2FA02F", "#DFFFDF", "#082808"],
    ["#6250D6", "#E4E0FF", "#1A1240"], ["#E34948", "#FFE0E0", "#3A0E0E"],
]
FAIT_AMI = "Pilote de la bande : la saison commence."


def cartes_amis(saison, premier_numero):
    """Une carte Mythique par joueur du championnat (docs/data/saison.json).

    La page recalcule la note, les stats et la phrase de ces cartes à partir des résultats : celles d'ici sont les valeurs
    de départ (avant le premier GP)."""
    numeros = defaultdict(lambda: defaultdict(int))
    for course in saison.get("courses", []):
        for r in course.get("resultats", []):
            if str(r.get("pilote", "")).startswith("j:") and r.get("numero") is not None:
                numeros[r["pilote"][2:]][r["numero"]] += 1
    annee = re.search(r"\d{4}", str(saison.get("saison", "")))
    annee = int(annee.group()) if annee else date.today().year
    cartes = []
    for i, j in enumerate(saison.get("joueurs", [])):
        alias = j.get("alias", [])
        pseudo = next((a for a in alias if not a.startswith("#")), j["nom"])
        numero_course = next((int(a[1:]) for a in alias if re.fullmatch(r"#\d+", a)), None)
        if numero_course is None and numeros[j["id"]]:
            numero_course = max(numeros[j["id"]].items(), key=lambda kv: kv[1])[0]  # le numéro le plus utilisé en course
        cartes.append({
            "id": f"{j['id']}--amis", "rarete": "mythique", "prenom": j["nom"], "nom": pseudo, "pilote": j["id"],
            "nationalite": "F1", "pays": "La bande", "ecurie": "amis", "saisons": str(saison.get("saison", "")),
            "debut": annee, "fin": annee, "fait": FAIT_AMI,
            "stats": {"titres": 0, "victoires": 0, "podiums": 0, "poles": 0, "departs": 0, "points": 0, "meilleur": None},
            "note": 92, "numero": premier_numero + i,
            "ami": j["id"], "numeroCourse": numero_course, "couleurs": COULEURS_AMIS[i % len(COULEURS_AMIS)],
        })
    return cartes


def appel(chemin):
    fichier = CACHE / (chemin.replace("/", "_").replace("?", "_").replace("&", "_").replace("=", "-") + ".json")
    if fichier.exists():
        return json.loads(fichier.read_text(encoding="utf-8"))
    for essai in range(5):
        try:
            with urllib.request.urlopen(f"{API}/{chemin}", timeout=30) as r:
                donnees = json.load(r)
            break
        except Exception as e:  # limite de débit ou coupure : on patiente puis on réessaie
            print(f"  nouvel essai ({e})", file=sys.stderr)
            time.sleep(5 * (essai + 1))
    else:
        raise RuntimeError(f"Échec de l'appel {chemin}")
    time.sleep(0.4)
    CACHE.mkdir(exist_ok=True)
    fichier.write_text(json.dumps(donnees), encoding="utf-8")
    return donnees


def pages(chemin, cle_table, cle_liste):
    """Récupère toutes les pages d'un endpoint et fusionne les courses découpées entre deux pages."""
    courses = {}
    offset, total = 0, 1
    while offset < total:
        d = appel(f"{chemin}.json?limit=100&offset={offset}")["MRData"]
        total = int(d["total"])
        offset += 100
        for course in d[cle_table]["Races"]:
            cible = courses.setdefault(course["round"], {**course, cle_liste: []})
            cible[cle_liste].extend(course.get(cle_liste, []))
    return list(courses.values())


def nom_saisons(annees):
    annees = sorted(annees)
    blocs, debut, prec = [], annees[0], annees[0]
    for a in annees[1:]:
        if a != prec + 1:
            blocs.append((debut, prec))
            debut = a
        prec = a
    blocs.append((debut, prec))
    return ", ".join(str(d) if d == f else f"{d}–{f}" for d, f in blocs)


def liste_fr(nombres):
    nombres = [str(n) for n in nombres]
    return nombres[0] if len(nombres) == 1 else ", ".join(nombres[:-1]) + " et " + nombres[-1]


def main():
    print(f"Saisons {PREMIERE_SAISON_STATS}–{DERNIERE_SAISON}…", file=sys.stderr)
    paires = defaultdict(lambda: {"annees": set(), "departs": 0, "victoires": 0, "podiums": 0, "poles": 0,
                                  "points": 0.0, "meilleur": None, "score": 0.0, "titres": []})
    pilotes, ecuries = {}, {}
    ecurie_par_saison = defaultdict(set)

    for annee in range(PREMIERE_SAISON_STATS, DERNIERE_SAISON + 1):
        courses = pages(f"{annee}/results", "RaceTable", "Results")
        if not courses:
            continue
        qualifs = {c["round"]: c["QualifyingResults"][0]["Driver"]["driverId"]
                   for c in pages(f"{annee}/qualifying/1", "RaceTable", "QualifyingResults") if c["QualifyingResults"]}
        if annee == 2021:  # la pole officielle des week-ends sprint revenait au vainqueur du sprint
            for c in pages(f"{annee}/sprint", "RaceTable", "SprintResults"):
                vainqueur = next((r for r in c["SprintResults"] if r["position"] == "1"), None)
                if vainqueur:
                    qualifs[c["round"]] = vainqueur["Driver"]["driverId"]
        for course in courses:
            pole = qualifs.get(course["round"])
            for r in course["Results"]:
                if any(s in r["status"].lower() for s in STATUTS_NON_PARTANT):
                    continue
                d, e = r["Driver"], r["Constructor"]
                pilotes[d["driverId"]] = d
                ecuries[e["constructorId"]] = e["name"]
                p = paires[(d["driverId"], e["constructorId"])]
                p["annees"].add(annee)
                ecurie_par_saison[(annee, d["driverId"])].add(e["constructorId"])
                pos = int(r["position"])
                p["departs"] += 1
                p["points"] += float(r["points"])
                p["victoires"] += pos == 1
                p["podiums"] += pos <= 3
                p["score"] += BAREME_ACTUEL[pos - 1] if pos <= 10 else 0
                if p["meilleur"] is None or pos < p["meilleur"]:
                    p["meilleur"] = pos
                if pole is None and r["grid"] == "1":
                    p["poles"] += 1
            if pole:
                for r in course["Results"]:
                    if r["Driver"]["driverId"] == pole:
                        paires[(pole, r["Constructor"]["constructorId"])]["poles"] += 1
                        break
        print(f"  {annee} : {len(courses)} courses", file=sys.stderr)

    # Champions (saison en cours exclue tant qu'elle n'est pas finie)
    for annee in range(PREMIERE_SAISON_STATS, DERNIERE_SAISON):
        listes = appel(f"{annee}/driverStandings/1.json")["MRData"]["StandingsTable"]["StandingsLists"]
        if not listes:
            continue
        saison = listes[0]
        pid = saison["DriverStandings"][0]["Driver"]["driverId"]
        for eid in ecurie_par_saison.get((annee, pid), {c["constructorId"] for c in saison["DriverStandings"][0]["Constructors"]}):
            if (pid, eid) in paires:
                paires[(pid, eid)]["titres"].append(annee)

    cartes = []
    for (pid, eid), p in paires.items():
        if max(p["annees"]) < PREMIERE_SAISON_CARTES:
            continue
        d = pilotes[pid]
        titres = sorted(p["titres"])
        if len(titres) >= 3:
            rarete = "icone"
        elif titres:
            rarete = "legendaire"
        elif p["victoires"]:
            rarete = "epique"
        elif p["podiums"]:
            rarete = "rare"
        elif p["points"] > 0:
            rarete = "peu_commune"
        else:
            rarete = "commune"
        moyenne = p["score"] / p["departs"]
        force = moyenne + 8 * len(titres) + 0.25 * p["victoires"] + 0.08 * p["podiums"] + 1.5 * math.log1p(p["departs"])
        points = round(p["points"], 1)
        points = int(points) if points == int(points) else points
        if titres:
            fait = f"Champion du monde {liste_fr(titres)}"
        elif p["victoires"]:
            fait = f"{p['victoires']} victoire{'s' * (p['victoires'] > 1)} en {p['departs']} départs"
        elif p["podiums"]:
            fait = f"{p['podiums']} podium{'s' * (p['podiums'] > 1)}, meilleur résultat : {p['meilleur']}e"
        elif p["points"]:
            fait = f"{points} point{'s' * (p['points'] > 1)}, meilleur résultat : {p['meilleur']}e"
        else:
            fait = f"{p['departs']} départ{'s' * (p['departs'] > 1)}, meilleur résultat : {p['meilleur']}e"
        code, pays = NATIONALITES.get(d.get("nationality"), (d.get("nationality", "?")[:3].upper(), d.get("nationality", "?")))
        cartes.append({
            "id": f"{pid}--{eid}", "rarete": rarete, "prenom": d["givenName"], "nom": d["familyName"],
            "pilote": pid, "nationalite": code, "pays": pays, "ecurie": eid, "saisons": nom_saisons(p["annees"]),
            "debut": min(p["annees"]), "fin": max(p["annees"]), "fait": fait, "_force": force,
            "stats": {"titres": len(titres), "victoires": p["victoires"], "podiums": p["podiums"], "poles": p["poles"],
                      "departs": p["departs"], "points": points, "meilleur": p["meilleur"]},
        })

    # Numérotation : du plus rare au plus courant, puis du plus fort au moins fort ; note dans la plage de la rareté
    ordre = [r["id"] for r in RARETES]
    cartes.sort(key=lambda c: (ordre.index(c["rarete"]), -c["_force"], c["nom"]))
    for rarete in RARETES:
        groupe = [c for c in cartes if c["rarete"] == rarete["id"]]
        bas, haut = rarete["notes"]
        for i, c in enumerate(groupe):
            c["note"] = haut if len(groupe) == 1 else round(haut - (haut - bas) * i / (len(groupe) - 1))
    for i, c in enumerate(cartes, start=1):
        c["numero"] = i
        del c["_force"]

    inconnues = sorted({c["ecurie"] for c in cartes} - set(COULEURS))
    if inconnues:
        print("Écuries sans couleurs (gris par défaut) :", inconnues, file=sys.stderr)
    natio_inconnues = sorted({pilotes[c["pilote"]].get("nationality") for c in cartes} - set(NATIONALITES))
    if natio_inconnues:
        print("Nationalités sans code :", natio_inconnues, file=sys.stderr)

    # Les cartes Mythiques des joueurs du championnat : numérotées à la suite des cartes de pilotes
    saison = json.loads(SAISON.read_text(encoding="utf-8")) if SAISON.exists() else {"joueurs": [], "courses": []}
    cartes += cartes_amis(saison, len(cartes) + 1)
    ecuries["amis"] = "La bande"

    # Les réglages faits dans l'admin (économie, raretés, cartes modifiées) survivent à une régénération
    ancien = json.loads(SORTIE.read_text(encoding="utf-8")) if SORTIE.exists() else {}
    reglages = {"pointsParBooster": 1, "cartesParBooster": 5, "derniereCarteMin": "peu_commune",
                "minutesParBoosterOffert": 60, "stockMaxBoostersOfferts": 10, "chanceMythiqueParBooster": 1,
                "pronosGainMeilleur": 2, "pronosGainOrdre": 4, "pronosGainMax": 60, "pronosLissage": 15}
    reglages.update({k: ancien[k] for k in reglages if k in ancien})
    anciennes = {r["id"]: r for r in ancien.get("raretes", [])}
    raretes = [{**r, **{k: anciennes[r["id"]][k] for k in ("poids", "fragments", "cout") if k in anciennes.get(r["id"], {})}}
               for r in RARETES]
    perso = {c["id"]: c["perso"] for c in ancien.get("cartes", []) if c.get("perso")}
    for c in cartes:
        c["auto"] = {"rarete": c["rarete"], "note": c["note"], "fait": c["fait"]}
        if c["id"] in perso:
            c["perso"] = perso[c["id"]]
            c.update(perso[c["id"]])

    catalogue = {
        "version": 1, "genere": date.today().isoformat(), "total": len(cartes), "premiereSaison": PREMIERE_SAISON_CARTES,
        **reglages,
        "raretes": raretes,
        "ecuries": {eid: {"nom": ecuries[eid], "couleurs": COULEURS.get(eid, ["#8A8A8A", "#FFFFFF", "#111111"])}
                    for eid in sorted({c["ecurie"] for c in cartes})},
        "cartes": cartes,
    }
    # Photos libres (Wikimedia Commons) et crédits, par pilote
    photos = json.loads(PHOTOS.read_text(encoding="utf-8")) if PHOTOS.exists() else {}
    catalogue["pilotes"] = {pid: photos[pid] for pid in sorted({c["pilote"] for c in cartes}) if pid in photos}
    SORTIE.parent.mkdir(parents=True, exist_ok=True)
    SORTIE.write_text(json.dumps(catalogue, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    compte = {r["id"]: sum(c["rarete"] == r["id"] for c in cartes) for r in RARETES}
    print(f"{len(cartes)} cartes -> {SORTIE}  {compte}")


if __name__ == "__main__":
    main()

"""Génère docs/cartes/catalogue.json : une carte par couple pilote × écurie depuis 2000.

Les stats de chaque carte sont celles du pilote dans cette écurie (toutes saisons confondues,
y compris avant 2000 pour les équipes déjà présentes). Source : API Jolpica (ex-Ergast).
Les réponses sont mises en cache dans outils/cache/ : relancer le script ne refait pas d'appels.

    py outils/catalogue.py
"""
import json
import math
import sys
import time
import urllib.request
from collections import defaultdict
from datetime import date
from pathlib import Path

RACINE = Path(__file__).resolve().parent.parent
CACHE = Path(__file__).resolve().parent / "cache"
SORTIE = RACINE / "docs" / "cartes" / "catalogue.json"
API = "https://api.jolpi.ca/ergast/f1"
PREMIERE_SAISON_CARTES = 2000
PREMIERE_SAISON_STATS = 1993  # début de stint le plus ancien encore actif en 2000 (Häkkinen chez McLaren)
DERNIERE_SAISON = date.today().year
BAREME_ACTUEL = [25, 18, 15, 12, 10, 8, 6, 4, 2, 1]

# Ordre du plus rare au plus courant. poids = chances de tirage, fragments = valeur d'un doublon,
# cout = fragments pour fabriquer la carte. Lus aussi par le serveur et la page.
RARETES = [
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
    "Venezuelan": ("VEN", "Venezuela"), "Argentinian": ("ARG", "Argentine"), "Estonian": ("EST", "Estonie"),
}

STATUTS_NON_PARTANT = ("qualify", "withdrew", "did not start", "excluded")


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

    catalogue = {
        "version": 1, "genere": date.today().isoformat(), "total": len(cartes),
        "cartesParBooster": 5, "derniereCarteMin": "peu_commune",
        "raretes": RARETES,
        "ecuries": {eid: {"nom": ecuries[eid], "couleurs": COULEURS.get(eid, ["#8A8A8A", "#FFFFFF", "#111111"])}
                    for eid in sorted({c["ecurie"] for c in cartes})},
        "cartes": cartes,
    }
    SORTIE.parent.mkdir(parents=True, exist_ok=True)
    SORTIE.write_text(json.dumps(catalogue, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    compte = {r["id"]: sum(c["rarete"] == r["id"] for c in cartes) for r in RARETES}
    print(f"{len(cartes)} cartes -> {SORTIE}  {compte}")


if __name__ == "__main__":
    main()

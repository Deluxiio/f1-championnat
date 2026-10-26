"""Enregistreur du championnat F1 25.

Écoute la télémétrie UDP du jeu, enregistre chaque course terminée dans
docs/data/saison.json, sert la page d'admin locale et publie la saison sur
GitHub (git commit + push) pour mettre à jour la page publique.
"""
import hashlib
import json
import os
import re
import socket
import subprocess
import sys
import threading
import time
import webbrowser
from collections import deque
from datetime import datetime
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError
from urllib.parse import urlparse
from urllib.request import Request, urlopen

import telemetrie as tl

RACINE = Path(__file__).resolve().parent.parent
FICHIER_SAISON = RACINE / "docs" / "data" / "saison.json"
FICHIER_CONFIG = Path(__file__).resolve().parent / "config.json"
FICHIER_CATALOGUE = RACINE / "docs" / "cartes" / "catalogue.json"
FICHIER_CONFIG_CARTES = RACINE / "docs" / "cartes" / "config.js"
FICHIER_CONFIG_SERVEUR = RACINE / "serveur" / "config.php"

CONFIG_DEFAUT = {
    "ecoute": {"ip": "127.0.0.1", "port": 20777},
    "portAdmin": 8025,
    # Pour utiliser une autre appli de télémétrie en même temps, ex. ["127.0.0.1:20778"]
    "renvoyerVers": [],
    "publicationAuto": True,
    # Ignore les courses hors ligne (tests en solo, etc.)
    "seulementEnLigne": True,
    "urlPublique": "",
    # Joueur qui fait tourner l'enregistreur : sa voiture est reconnue même si le jeu masque son pseudo
    "joueurLocal": "joueur1",
}

# Noms affichés par le jeu quand les pseudos en ligne sont masqués : on identifie alors par numéro
NOMS_GENERIQUES = {"player", "pilote", "joueur", "piloto", "spieler", "pilota", "giocatore", "jugador"}

CIRCUITS = {
    0: "Australie", 2: "Chine", 3: "Bahreïn", 4: "Espagne", 5: "Monaco", 6: "Canada",
    7: "Grande-Bretagne", 9: "Hongrie", 10: "Belgique", 11: "Italie", 12: "Singapour",
    13: "Japon", 14: "Abu Dhabi", 15: "États-Unis", 16: "Brésil", 17: "Autriche",
    19: "Mexique", 20: "Azerbaïdjan", 26: "Pays-Bas", 27: "Émilie-Romagne",
    29: "Arabie saoudite", 30: "Miami", 31: "Las Vegas", 32: "Qatar",
    39: "Grande-Bretagne (inversé)", 40: "Autriche (inversé)", 41: "Pays-Bas (inversé)",
}
# Les tracés inversés comptent pour le GP du circuit d'origine
CIRCUIT_DE_BASE = {39: 7, 40: 17, 41: 26}

SANS_FENETRE = getattr(subprocess, "CREATE_NO_WINDOW", 0)


def nom_circuit(cid):
    return CIRCUITS.get(cid, f"Circuit n°{cid}")


def joli_nom(nom):
    """« VERSTAPPEN » -> « Verstappen » ; les noms déjà en casse mixte sont gardés."""
    if nom.isupper():
        return " ".join(m.capitalize() for m in nom.split())
    return nom


def maintenant():
    return datetime.now().isoformat(timespec="seconds")


def lire_json(chemin):
    with open(chemin, encoding="utf-8") as f:
        return json.load(f)


def ecrire_json(chemin, donnees):
    tmp = chemin.with_suffix(".tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(donnees, f, ensure_ascii=False, indent=1)
        f.write("\n")
    os.replace(tmp, chemin)


def charger_config():
    config = json.loads(json.dumps(CONFIG_DEFAUT))
    if FICHIER_CONFIG.exists():
        config.update(lire_json(FICHIER_CONFIG))
    else:
        ecrire_json(FICHIER_CONFIG, config)
    return config


class ConflitGithub(Exception):
    """La saison de GitHub et celle de ce PC ne se fusionnent pas toutes seules."""


MESSAGE_CONFLIT = ("Échec de la publication : GitHub a une autre version de la saison, en conflit avec celle de ce PC. "
                   "Rien n'est perdu : la saison de ce PC est intacte (voir « Échec de la publication » dans le README).")


def push_refuse(e):
    """Vrai quand GitHub refuse le push parce qu'il a des commits que ce PC n'a pas (pas pour des droits ou un hook)."""
    texte = (e.stderr or "") + (e.stdout or "")
    return "[rejected]" in texte or "fetch first" in texte or "non-fast-forward" in texte


def detail_git(e):
    """La ligne la plus parlante de l'erreur de git, sans les « hint: » ni l'adresse du dépôt (« To … »)."""
    lignes = [l.strip() for l in (e.stderr or e.stdout or "").splitlines() if l.strip()]
    utiles = [l for l in lignes if not l.startswith(("hint:", "To "))]
    return next((l for l in utiles if l.startswith(("fatal:", "error:", "remote:"))), (utiles or lignes or [str(e)])[-1])


class Enregistreur:
    def __init__(self, config):
        self.config = config
        self.verrou = threading.RLock()
        self.saison = lire_json(FICHIER_SAISON)
        self.revision = 1
        self.seances = {}
        self.uid_courant = None
        self.paquets = 0
        self.dernier_paquet = None
        self.ecoute = {"ok": False, "erreur": None}
        self.journal = deque(maxlen=40)
        self._erreurs_vues = set()
        self.publication = {"etat": "inactif", "message": "", "date": None}
        self._pub_evenement = threading.Event()
        self._pub_message = None

    # --- Journal -----------------------------------------------------------

    def log(self, msg):
        self.journal.appendleft({"date": maintenant(), "msg": msg})
        print(f"[{datetime.now():%H:%M:%S}] {msg}", flush=True)

    def log_une_fois(self, cle, msg):
        if cle not in self._erreurs_vues:
            self._erreurs_vues.add(cle)
            self.log(msg)

    # --- Télémétrie --------------------------------------------------------

    def ecouter(self):
        ip, port = self.config["ecoute"]["ip"], self.config["ecoute"]["port"]
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            sock.bind((ip, port))
        except OSError as e:
            self.ecoute = {"ok": False, "erreur": f"Impossible d'écouter {ip}:{port} ({e}). Une autre appli utilise peut-être ce port."}
            self.log(self.ecoute["erreur"])
            return
        self.ecoute = {"ok": True, "erreur": None}
        self.log(f"En écoute de la télémétrie sur {ip}:{port}")
        renvois = []
        for cible in self.config.get("renvoyerVers", []):
            hote, _, p = cible.rpartition(":")
            renvois.append((hote, int(p)))
        while True:
            data, _ = sock.recvfrom(4096)
            for cible in renvois:
                sock.sendto(data, cible)
            try:
                self.recevoir(data)
            except Exception as e:  # un paquet inattendu ne doit jamais arrêter l'écoute
                self.log_une_fois(("paquet", type(e).__name__), f"Paquet illisible ignoré : {e!r}")

    def recevoir(self, data):
        e = tl.entete(data)
        if not e:
            return
        fmt = tl.format_gere(e["format"])
        if not fmt:
            self.log_une_fois(("format", e["format"]),
                              f"Format UDP {e['format']} non géré : choisis le format 2025 dans les réglages télémétrie du jeu")
            return
        self.paquets += 1
        self.dernier_paquet = time.time()
        if e["uid"] == 0:
            return
        with self.verrou:
            s = self.seances.get(e["uid"])
            if s is None:
                s = self.seances[e["uid"]] = {"uid": e["uid"], "session": None, "participants": None,
                                              "nbActifs": 0, "tours": None, "classee": False}
                self._oublier_vieilles_seances()
            s["maj"] = time.time()
            s["voitureJoueur"] = e["voitureJoueur"]
            self.uid_courant = e["uid"]

            if e["id"] == tl.PAQUET_SESSION:
                nouvelle = s["session"] is None
                s["session"] = tl.session(data)
                if nouvelle:
                    info = s["session"]
                    self.log(f"Séance détectée : {tl.NOMS_SEANCES.get(info['type'], info['type'])} – "
                             f"{nom_circuit(info['circuit'])} ({'en ligne' if info['enLigne'] else 'hors ligne'})")
                    self._signaler_depart(info)
            elif e["id"] == tl.PAQUET_PARTICIPANTS:
                s["nbActifs"], s["participants"] = tl.participants(data, fmt)
            elif e["id"] == tl.PAQUET_TOURS:
                s["tours"] = tl.tours(data)
            elif e["id"] == tl.PAQUET_CLASSEMENT:
                _, lignes = tl.classement(data, fmt)
                self._classement_final(s, lignes)

    def _oublier_vieilles_seances(self):
        if len(self.seances) > 8:
            for uid in sorted(self.seances, key=lambda u: self.seances[u].get("maj", 0))[:-8]:
                del self.seances[uid]

    def _classement_final(self, s, lignes):
        if s["classee"]:
            return
        s["classee"] = True
        info = s["session"]
        if info is None:
            self.log("Classement final reçu sans informations de séance : ignoré")
            return
        nom_seance = tl.NOMS_SEANCES.get(info["type"], f"Séance {info['type']}")
        if info["type"] not in tl.SEANCES_COURSE:
            self.log(f"{nom_seance} terminée à {nom_circuit(info['circuit'])} : ignorée (seules les courses comptent)")
            return
        if self.config.get("seulementEnLigne", True) and not info["enLigne"]:
            self.log(f"Course hors ligne terminée à {nom_circuit(info['circuit'])} : ignorée (réglage seulementEnLigne)")
            return
        if any(c["id"] == str(s["uid"]) for c in self.saison["courses"]):
            return
        course = self._construire_course(s, lignes, "telemetrie")
        self.saison["courses"].append(course)
        self.sauver()
        self.fermer_pronostics(course.get("manche"), "fin de la course")  # au cas où le départ aurait été manqué
        vainqueur = course["resultats"][0]["nom"] if course["resultats"] else "?"
        self.log(f"Course enregistrée : {self._libelle(course)} – vainqueur {vainqueur}"
                 + (" (à vérifier)" if course["aVerifier"] else ""))
        if self.config.get("publicationAuto", True):
            self.demander_publication(f"Résultat : {self._libelle(course)}")

    # --- Pronostics : fermeture au départ de la course -----------------------

    def _signaler_depart(self, info):
        """Une course (en ligne) démarre : les pronostics de ce GP se ferment, pour que personne ne parie en la voyant se jouer."""
        if info["type"] not in tl.SEANCES_COURSE:
            return
        if self.config.get("seulementEnLigne", True) and not info["enLigne"]:
            return
        circuit = info.get("circuit")
        self.fermer_pronostics(self._manche_pour(circuit) if circuit is not None else None, "départ de la course")  # hors calendrier : rien à fermer

    def fermer_pronostics(self, manche, raison):
        """Prévient le serveur des cartes, en arrière-plan : la télémétrie ne doit jamais attendre le réseau."""
        if manche is None:
            return
        threading.Thread(target=self._appeler_fermeture, args=(manche, raison), daemon=True).start()

    def _appeler_fermeture(self, manche, raison):
        cfg = config_serveur_cartes()
        if not cfg["api"] or not cfg["cleAdmin"]:
            self.log_une_fois("pronos-config", "Pronostics : serveur des cartes pas configuré, ils ne se fermeront pas tout seuls (bouton dans l'admin)")
            return
        corps = {"cle": cfg["cleAdmin"], "manche": manche}
        url = cfg["api"] + ("&" if "?" in cfg["api"] else "?") + "action=pronosFermer"
        erreur = ""
        for attente in (0, 3, 10):
            time.sleep(attente)
            try:
                requete = Request(url, data=json.dumps(corps).encode("utf-8"), method="POST",
                                  headers={"Content-Type": "text/plain;charset=UTF-8"})
                with urlopen(requete, timeout=15) as r:
                    reponse = json.load(r)
                if isinstance(reponse, dict) and reponse.get("change") and reponse.get("statut") == "ferme":
                    self.log(f"Pronostics fermés ({raison}) : GP n°{reponse.get('manche')} {reponse.get('gp') or ''}".rstrip())
                return  # déjà fermés (ex. au départ) : rien à dire
            except HTTPError as e:
                if e.code in (403, 404):  # clé refusée ou ancienne version de api.php : réessayer ne change rien
                    self.log(f"Pronostics : fermeture refusée par le serveur ({e.code}) — vérifie CLE_ADMIN et la version de api.php")
                    return
                erreur = f"erreur {e.code}"
            except Exception as e:  # réseau, réponse coupée, JSON inattendu… : ce thread ne doit jamais mourir en silence
                erreur = str(e) or type(e).__name__
        self.log(f"Pronostics : impossible de les fermer ({erreur}) — ferme-les à la main dans l'admin")

    # --- Construction des courses ----------------------------------------

    def _joueur_par_nom(self, nom):
        cle = nom.casefold()
        for j in self.saison["joueurs"]:
            if cle == j["nom"].casefold() or cle in (a.casefold() for a in j.get("alias", [])):
                return j
        return None

    def _noms_ambigus(self, s):
        """Pseudos qui ne permettent pas d'identifier un joueur : génériques ou portés par plusieurs humains."""
        noms = [p["nom"].casefold() for p in (s["participants"] or []) if p["nom"] and not p["ia"]]
        return {n for n in noms if noms.count(n) > 1} | NOMS_GENERIQUES

    def _cle_humain(self, p, ambigus):
        """Ce qui sert d'alias pour reconnaître ce joueur : son pseudo, ou « #numéro » s'il est masqué."""
        return f"#{p['numero']}" if p["nom"].casefold() in ambigus else p["nom"]

    def _joueur_humain(self, s, i, p, ambigus):
        if i == s.get("voitureJoueur") and self.config.get("joueurLocal"):
            local = next((j for j in self.saison["joueurs"] if j["id"] == self.config["joueurLocal"]), None)
            if local:
                return local
        return self._joueur_par_nom(self._cle_humain(p, ambigus))

    def _identite(self, s, p, i, remarques, ambigus):
        if p is None:
            return {"pilote": f"voiture:{i}", "nom": f"Voiture {i + 1}", "ecurie": None, "numero": None}
        ident = {"ecurie": p["ecurie"], "numero": p["numero"]}
        # Un joueur qui quitte la partie est remplacé par une IA qui garde son pseudo (id pilote 255) : on le reconnaît quand même
        if p["ia"] and p["piloteId"] != 255:
            return {"pilote": f"ia:{p['piloteId']}", "nom": joli_nom(p["nom"]), **ident}
        joueur = self._joueur_humain(s, i, p, ambigus)
        if joueur:
            return {"pilote": f"j:{joueur['id']}", "nom": joueur["nom"], **ident}
        cle = self._cle_humain(p, ambigus)
        nom = p["nom"] if cle == p["nom"] else f"{p['nom']} {cle}"
        remarques.append(f"Joueur non reconnu : « {nom} » (associe-le à l'un de vous dans l'admin)")
        return {"pilote": f"inconnu:{cle}", "nom": nom, **ident}

    def _manche_pour(self, circuit):
        base = CIRCUIT_DE_BASE.get(circuit, circuit)
        prises = {c.get("manche") for c in self.saison["courses"]}
        for m in self.saison["calendrier"]:
            if m["circuit"] == base and m["manche"] not in prises:
                return m["manche"]
        return None

    def _construire_course(self, s, lignes, source):
        info = s["session"] or {}
        participants = s["participants"] or []
        remarques = []
        resultats = []
        ambigus = self._noms_ambigus(s)
        for i, c in enumerate(lignes):
            if c["pos"] == 0:
                continue
            p = participants[i] if i < len(participants) else None
            r = {"pos": c["pos"], **self._identite(s, p, i, remarques, ambigus), "grille": c["grille"],
                 "tours": c["tours"], "statut": tl.STATUTS.get(c["statutJeu"], "nc"),
                 "statutJeu": c["statutJeu"], "meilleurTour": c["meilleurTour"] or None,
                 "tempsTotal": c["tempsTotal"], "penalites": c["penalites"],
                 "nbPenalites": c["nbPenalites"], "arrets": c["arrets"],
                 "pointsJeu": c["pointsJeu"], "pneus": c["pneus"]}
            resultats.append(r)
        # Deux voitures reconnues comme le même joueur (même numéro, par ex.) : on ne devine pas
        for r in resultats:
            if r["pilote"].startswith("j:") and sum(x["pilote"] == r["pilote"] for x in resultats) > 1:
                remarques.append(f"Plusieurs voitures reconnues comme {r['nom']} (n°{r['numero']}) : vérifie qui est qui")
                r["pilote"], r["nom"] = f"inconnu:#{r['numero']}", f"{r['nom']} ? #{r['numero']}"
        resultats.sort(key=lambda r: r["pos"])
        circuit = info.get("circuit")
        manche = self._manche_pour(circuit) if circuit is not None else None
        if manche is None:
            remarques.append("Circuit hors calendrier ou GP déjà couru : choisis la manche dans l'admin")
        return {"id": str(s["uid"]) if source == "telemetrie" else f"manuel-{int(time.time())}",
                "manche": manche, "circuit": circuit, "date": maintenant(), "source": source,
                "tours": info.get("toursTotal"), "aVerifier": bool(remarques),
                "remarques": remarques, "resultats": resultats}

    def _libelle(self, course):
        m = f"Manche {course['manche']} – " if course.get("manche") else ""
        return m + nom_circuit(course.get("circuit"))

    def brouillon(self):
        """Course pré-remplie depuis la dernière course captée (si le classement final a manqué)."""
        with self.verrou:
            courses = [s for s in self.seances.values()
                       if s["session"] and s["session"]["type"] in tl.SEANCES_COURSE and s["tours"]]
            if not courses:
                return None
            s = max(courses, key=lambda x: x["maj"])
            lignes = [{"pos": t["pos"], "tours": t["tour"], "grille": t["grille"], "pointsJeu": 0,
                       "arrets": t["arrets"], "statutJeu": t["statutJeu"], "meilleurTour": 0,
                       "tempsTotal": 0, "penalites": t["penalites"], "nbPenalites": 0, "pneus": []}
                      for t in s["tours"]]
            course = self._construire_course(s, lignes, "manuel")
            course["aVerifier"] = True
            course["remarques"].insert(0, "Course créée depuis les dernières positions captées : vérifie l'ordre et les statuts")
            return course

    # --- Sauvegarde & état -------------------------------------------------

    def sauver(self):
        with self.verrou:
            self.saison["maj"] = maintenant()
            ecrire_json(FICHIER_SAISON, self.saison)
            self.revision += 1

    def remplacer_saison(self, saison):
        with self.verrou:
            self.saison = saison
            self.sauver()

    def etat(self):
        with self.verrou:
            seance = None
            s = self.seances.get(self.uid_courant)
            if s and s["session"]:
                info = s["session"]
                parts = [p for p in (s["participants"] or []) if p["nom"]]
                tour = max((t["tour"] for t in (s["tours"] or []) if t["pos"] == 1), default=None)
                humains = []
                ambigus = self._noms_ambigus(s)
                for i, p in enumerate(s["participants"] or []):
                    if p["nom"] and not p["ia"]:
                        j = self._joueur_humain(s, i, p, ambigus)
                        humains.append({"nom": p["nom"], "numero": p["numero"], "ecurie": p["ecurie"],
                                        "cle": self._cle_humain(p, ambigus), "local": i == s.get("voitureJoueur"),
                                        "joueur": j["nom"] if j else None})
                seance = {"type": tl.NOMS_SEANCES.get(info["type"], str(info["type"])),
                          "estCourse": info["type"] in tl.SEANCES_COURSE,
                          "circuit": nom_circuit(info["circuit"]), "enLigne": info["enLigne"],
                          "tour": tour, "toursTotal": info["toursTotal"], "nbVoitures": s["nbActifs"],
                          "humains": humains, "classee": s["classee"]}
            return {
                "ecoute": {**self.ecoute, **self.config["ecoute"]},
                "paquets": self.paquets,
                "dernierPaquetIlYa": round(time.time() - self.dernier_paquet, 1) if self.dernier_paquet else None,
                "seance": seance,
                "publication": self.publication,
                "publicationAuto": self.config.get("publicationAuto", True),
                "seulementEnLigne": self.config.get("seulementEnLigne", True),
                "urlPublique": self.config.get("urlPublique", ""),
                "journal": list(self.journal),
                "revision": self.revision,
            }

    # --- Publication (git) -------------------------------------------------

    def demander_publication(self, message):
        self._pub_message = message
        self._pub_evenement.set()

    def _git(self, *args, verifier=True):
        return subprocess.run(["git", "-C", str(RACINE), *args], capture_output=True, text=True,
                              encoding="utf-8", errors="replace", timeout=120,
                              check=verifier, creationflags=SANS_FENETRE)

    def boucle_publication(self):
        while True:
            self._pub_evenement.wait()
            self._pub_evenement.clear()
            self.publier(self._pub_message or "Mise à jour du championnat")

    def publier(self, message):
        """Commit puis push de la saison et du catalogue.

        Si GitHub a reçu d'autres commits entre-temps (une mise à jour du site faite ailleurs), le push est refusé :
        on les intègre sous les nôtres puis on republie, au lieu de rester bloqué jusqu'à un git pull à la main."""
        if not (RACINE / ".git").exists():
            self.publication = {"etat": "erreur", "date": maintenant(),
                                "message": "Dépôt GitHub pas encore configuré (voir README)"}
            return
        self.publication = {"etat": "en_cours", "message": "Publication en cours…", "date": maintenant()}
        try:
            self._git("add", "docs/data/saison.json", "docs/cartes/catalogue.json")
            if self._git("diff", "--cached", "--quiet", verifier=False).returncode != 0:
                self._git("commit", "-m", message)
            try:
                self._git("push", "--quiet")
            except subprocess.CalledProcessError as e:
                if not push_refuse(e):
                    raise
                self._integrer_github()
                self._git("push", "--quiet")
            self.publication = {"etat": "ok", "date": maintenant(),
                                "message": "Publié : la page publique se met à jour d'ici 1 à 2 minutes"}
            self.log(f"Publié sur GitHub ({message})")
        except ConflitGithub:
            self.publication = {"etat": "erreur", "date": maintenant(), "message": MESSAGE_CONFLIT}
            self.log(self.publication["message"])
        except subprocess.CalledProcessError as e:
            detail = ("GitHub a reçu d'autres changements pendant la publication : réessaie dans un instant"
                      if push_refuse(e) else detail_git(e))
            self.publication = {"etat": "erreur", "date": maintenant(), "message": "Échec de la publication : " + detail}
            self.log(self.publication["message"])
        except (OSError, subprocess.TimeoutExpired) as e:
            self.publication = {"etat": "erreur", "date": maintenant(),
                                "message": f"Échec de la publication : {e}"}
            self.log(self.publication["message"])

    def _integrer_github(self):
        """GitHub a des commits que ce PC n'a pas : on les glisse sous les nôtres (pull --rebase).

        Si les deux versions de la saison ne se fusionnent pas, tout est annulé et le dépôt redevient comme avant.
        Si la saison a changé sur le disque, l'enregistreur repart de celle-ci, sinon il l'écraserait à la prochaine sauvegarde."""
        avant = FICHIER_SAISON.read_bytes()
        try:
            self._git("pull", "--rebase", "--autostash", "--quiet")
        except subprocess.CalledProcessError:
            if self._git("rebase", "--abort", verifier=False).returncode == 0:   # un rebase était bien en cours : conflit
                raise ConflitGithub()
            raise
        # Un fichier modifié à la main sur ce PC que GitHub a aussi changé : git le laisse plein de marques de conflit et
        # bloque les commits suivants. On remet la version de GitHub ; la modification à la main reste dans « git stash list ».
        bloques = [p for p in self._git("diff", "--name-only", "--diff-filter=U", "-z", verifier=False).stdout.split("\0") if p]
        if bloques:
            self._git("checkout", "HEAD", "--", *bloques, verifier=False)
            self.log("Modification faite à la main mise de côté (" + ", ".join(bloques) + ") : elle entrait en conflit avec GitHub. "
                     "Elle est gardée dans « git stash list ».")
        if FICHIER_SAISON.read_bytes() != avant:
            with self.verrou:
                self.saison = lire_json(FICHIER_SAISON)
                self.revision += 1
        self.log("GitHub avait de nouveaux changements : intégrés")


# --- Serveur de l'admin ------------------------------------------------------

def empreinte(contenu):
    return hashlib.sha1(contenu).hexdigest()


def config_serveur_cartes():
    """Adresse du serveur des cartes et clé admin, pour gérer les comptes depuis l'admin locale."""
    api = cle = ""
    if FICHIER_CONFIG_CARTES.exists():
        m = re.search(r"CARTES_API\s*=\s*[\"']([^\"']*)", FICHIER_CONFIG_CARTES.read_text(encoding="utf-8"))
        api = m.group(1) if m else ""
    if FICHIER_CONFIG_SERVEUR.exists():
        m = re.search(r"CLE_ADMIN\s*=\s*'([^']*)'", FICHIER_CONFIG_SERVEUR.read_text(encoding="utf-8"))
        cle = m.group(1) if m else ""
    return {"api": api, "cleAdmin": cle}


def creer_gestionnaire(app):
    class Gestionnaire(SimpleHTTPRequestHandler):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, directory=str(RACINE), **kwargs)

        def log_message(self, *args):
            pass

        def end_headers(self):
            self.send_header("Cache-Control", "no-store")
            super().end_headers()

        def _json(self, donnees, statut=HTTPStatus.OK):
            corps = json.dumps(donnees, ensure_ascii=False).encode("utf-8")
            self.send_response(statut)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(corps)))
            self.end_headers()
            self.wfile.write(corps)

        def _corps(self):
            longueur = int(self.headers.get("Content-Length", 0))
            return json.loads(self.rfile.read(longueur) or b"{}")

        def do_GET(self):
            chemin = urlparse(self.path).path
            if chemin == "/":
                self.send_response(HTTPStatus.FOUND)
                self.send_header("Location", "/admin/")
                self.end_headers()
            elif chemin == "/api/etat":
                self._json(app.etat())
            elif chemin == "/api/saison":
                with app.verrou:
                    self._json({"revision": app.revision, "saison": app.saison})
            elif chemin == "/api/catalogue":
                with app.verrou:
                    contenu = FICHIER_CATALOGUE.read_bytes()
                    self._json({"revision": empreinte(contenu), "catalogue": json.loads(contenu)})
            elif chemin == "/api/cartes-serveur":
                self._json(config_serveur_cartes())
            elif chemin == "/api/brouillon":
                course = app.brouillon()
                self._json({"course": course}, HTTPStatus.OK if course else HTTPStatus.NOT_FOUND)
            elif chemin.startswith(("/admin/", "/docs/")):
                super().do_GET()
            else:
                self.send_error(HTTPStatus.NOT_FOUND)

        def do_PUT(self):
            chemin = urlparse(self.path).path
            if chemin == "/api/catalogue":
                return self._put_catalogue()
            if chemin != "/api/saison":
                return self.send_error(HTTPStatus.NOT_FOUND)
            corps = self._corps()
            saison = corps.get("saison")
            if not isinstance(saison, dict) or not all(isinstance(saison.get(k), list)
                                                       for k in ("courses", "joueurs", "calendrier")):
                return self._json({"erreur": "Saison invalide"}, HTTPStatus.BAD_REQUEST)
            with app.verrou:
                if corps.get("revision") != app.revision:
                    return self._json({"erreur": "La saison a changé entre-temps (nouvelle course ?). Recharge la page.",
                                       "revision": app.revision}, HTTPStatus.CONFLICT)
                app.remplacer_saison(saison)
                revision = app.revision
            if corps.get("publier"):
                app.demander_publication(corps.get("message") or "Correction du championnat")
            self._json({"revision": revision})

        def _put_catalogue(self):
            corps = self._corps()
            catalogue = corps.get("catalogue")
            if not isinstance(catalogue, dict) or not isinstance(catalogue.get("cartes"), list)                     or not isinstance(catalogue.get("raretes"), list) or not catalogue["cartes"]:
                return self._json({"erreur": "Catalogue invalide"}, HTTPStatus.BAD_REQUEST)
            with app.verrou:
                # L'empreinte du fichier détecte aussi une mise à jour faite hors de l'admin (nouveau catalogue)
                if corps.get("revision") != empreinte(FICHIER_CATALOGUE.read_bytes()):
                    return self._json({"erreur": "Le catalogue a changé entre-temps (mise à jour des cartes ?). "
                                                 "Recharge la page avant de modifier."}, HTTPStatus.CONFLICT)
                ecrire_json(FICHIER_CATALOGUE, catalogue)
                revision = empreinte(FICHIER_CATALOGUE.read_bytes())
            if corps.get("publier"):
                app.demander_publication(corps.get("message") or "Réglages des cartes")
            self._json({"revision": revision})

        def do_POST(self):
            if urlparse(self.path).path != "/api/publier":
                return self.send_error(HTTPStatus.NOT_FOUND)
            app.demander_publication(self._corps().get("message") or "Mise à jour du championnat")
            self._json({"ok": True})

    return Gestionnaire


def main():
    config = charger_config()
    url = f"http://localhost:{config['portAdmin']}/admin/"
    try:
        serveur = ThreadingHTTPServer(("127.0.0.1", config["portAdmin"]), None)
    except OSError:
        print(f"L'enregistreur semble déjà lancé : ouverture de {url}")
        webbrowser.open(url)
        return
    app = Enregistreur(config)
    serveur.RequestHandlerClass = creer_gestionnaire(app)
    threading.Thread(target=app.ecouter, daemon=True).start()
    threading.Thread(target=app.boucle_publication, daemon=True).start()
    print(f"Championnat F1 25 : admin sur {url}  (Ctrl+C pour arrêter)")
    if "--sans-navigateur" not in sys.argv:
        webbrowser.open(url)
    try:
        serveur.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()

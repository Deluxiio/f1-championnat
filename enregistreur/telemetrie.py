"""Décodage des paquets UDP de F1 25 (format 2025) et F1 24 (format 2024).

Seuls les paquets utiles au championnat sont décodés : session, tours,
participants et classement final. Spécification officielle :
https://forums.ea.com/blog/f1-games-game-info-hub-en/f1%c2%ae-25-udp-specification/12187347
"""
import struct

ENTETE = struct.Struct("<HBBBBBQfIIBB")  # 29 octets

PAQUET_SESSION = 1
PAQUET_TOURS = 2
PAQUET_PARTICIPANTS = 4
PAQUET_CLASSEMENT = 8

NB_VOITURES = 22

# Types de séance (F1 24 / F1 25) : 15 = Course, 16 = Course 2, 17 = Course 3
SEANCES_COURSE = {15, 16, 17}
NOMS_SEANCES = {
    0: "Inconnue", 1: "Essais 1", 2: "Essais 2", 3: "Essais 3", 4: "Essais courts",
    5: "Q1", 6: "Q2", 7: "Q3", 8: "Qualif courte", 9: "Qualif un tour",
    10: "Sprint Shootout 1", 11: "Sprint Shootout 2", 12: "Sprint Shootout 3",
    13: "Sprint Shootout court", 14: "Sprint Shootout un tour",
    15: "Course", 16: "Course 2", 17: "Course 3", 18: "Contre-la-montre",
}

# Code de statut du jeu -> statut stocké dans la saison
STATUTS = {0: "absent", 1: "absent", 2: "fini", 3: "fini", 4: "abandon",
           5: "dsq", 6: "nc", 7: "abandon"}

_SESSION_DEBUT = struct.Struct("<BbbBHBb")  # météo .. trackId
_OFFSET_EN_LIGNE = ENTETE.size + 125        # m_networkGame

_PARTICIPANT = {
    2025: struct.Struct("<7B32sBBHBB12x"),  # 57 octets (avec 4 couleurs de livrée)
    2024: struct.Struct("<7B48sBBHB"),      # 60 octets
}

_CLASSEMENT = {
    2025: struct.Struct("<7BIdBBB8s8s8s"),  # 46 octets (avec m_resultReason)
    2024: struct.Struct("<6BIdBBB8s8s8s"),  # 45 octets
}

# On ne garde de LapData que les octets 32 à 46 (position, tour, arrêts, grille, statut...)
_TOUR = struct.Struct("<32x15B10x")  # 57 octets


def entete(data):
    if len(data) < ENTETE.size:
        return None
    (fmt, annee, _maj, _min, _ver, pid, uid, temps, _f, _fo, joueur, _j2) = ENTETE.unpack_from(data)
    return {"format": fmt, "id": pid, "uid": uid, "temps": temps, "voitureJoueur": joueur}


def format_gere(fmt):
    return fmt if fmt in _PARTICIPANT else None


def session(data):
    meteo, t_piste, t_air, tours, longueur, type_seance, circuit = _SESSION_DEBUT.unpack_from(data, ENTETE.size)
    en_ligne = data[_OFFSET_EN_LIGNE] if len(data) > _OFFSET_EN_LIGNE else 0
    return {"type": type_seance, "circuit": circuit, "toursTotal": tours, "enLigne": bool(en_ligne)}


def _texte(brut):
    return brut.split(b"\x00", 1)[0].decode("utf-8", errors="replace").strip()


def participants(data, fmt):
    st = _PARTICIPANT[fmt]
    nb_actifs = data[ENTETE.size]
    liste = []
    for i in range(NB_VOITURES):
        champs = st.unpack_from(data, ENTETE.size + 1 + i * st.size)
        ia, pilote_id, reseau_id, ecurie, _mon_ecurie, numero, _nat, nom = champs[:8]
        liste.append({"ia": bool(ia), "piloteId": pilote_id, "reseauId": reseau_id,
                      "ecurie": ecurie, "numero": numero, "nom": _texte(nom)})
    return nb_actifs, liste


def classement(data, fmt):
    st = _CLASSEMENT[fmt]
    nb = data[ENTETE.size]
    liste = []
    for i in range(NB_VOITURES):
        champs = st.unpack_from(data, ENTETE.size + 1 + i * st.size)
        if fmt == 2025:
            pos, tours, grille, points, arrets, statut, _raison = champs[:7]
            reste = champs[7:]
        else:
            pos, tours, grille, points, arrets, statut = champs[:6]
            reste = champs[6:]
        meilleur, total, penalites, nb_penalites, nb_relais, _reels, visuels, _fins = reste
        liste.append({"pos": pos, "tours": tours, "grille": grille, "pointsJeu": points,
                      "arrets": arrets, "statutJeu": statut, "meilleurTour": meilleur,
                      "tempsTotal": round(total, 3), "penalites": penalites,
                      "nbPenalites": nb_penalites, "pneus": list(visuels[:nb_relais])})
    return nb, liste


def tours(data):
    liste = []
    for i in range(NB_VOITURES):
        champs = _TOUR.unpack_from(data, ENTETE.size + i * _TOUR.size)
        pos, tour, _stand, arrets, _sect, _inv, penalites = champs[:7]
        grille, _etat, statut = champs[11:14]
        liste.append({"pos": pos, "tour": tour, "arrets": arrets, "penalites": penalites,
                      "grille": grille, "statutJeu": statut})
    return liste

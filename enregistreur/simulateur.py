"""Simule une séance F1 25 en envoyant de vrais paquets UDP (format 2025).

Sert à tester l'enregistreur sans lancer le jeu :
    py simulateur.py --circuit 0 --humains "Pseudo1,Pseudo2,Pseudo3,Pseudo4"
"""
import argparse
import random
import socket
import struct
import time

import telemetrie as tl

GRILLE_IA = [  # (nom, écurie, id pilote)
    ("RUSSELL", 0, 50), ("ANTONELLI", 0, 160), ("LECLERC", 1, 58), ("HAMILTON", 1, 7),
    ("VERSTAPPEN", 2, 9), ("TSUNODA", 2, 94), ("ALBON", 3, 62), ("SAINZ", 3, 0),
    ("ALONSO", 4, 3), ("STROLL", 4, 19), ("GASLY", 5, 59), ("COLAPINTO", 5, 161),
    ("HADJAR", 6, 162), ("LAWSON", 6, 163), ("OCON", 7, 17), ("BEARMAN", 7, 164),
    ("NORRIS", 8, 54), ("PIASTRI", 8, 112), ("HULKENBERG", 9, 10), ("BORTOLETO", 9, 165),
]
# Sièges pris par les joueurs humains (on remplace ces pilotes IA)
SIEGES_HUMAINS = [3, 17, 7, 11]

TAILLE_SESSION = 753


def entete(pid, uid):
    return tl.ENTETE.pack(2025, 25, 1, 10, 1, pid, uid, 0.0, 0, 0, 0, 255)


def paquet_session(uid, circuit, type_seance, en_ligne, tours):
    buf = bytearray(TAILLE_SESSION)
    buf[:tl.ENTETE.size] = entete(tl.PAQUET_SESSION, uid)
    struct.pack_into("<BbbBHBb", buf, tl.ENTETE.size, 0, 32, 24, tours, 5278, type_seance, circuit)
    buf[tl.ENTETE.size + 125] = 1 if en_ligne else 0
    return bytes(buf)


def paquet_participants(uid, voitures):
    st = struct.Struct("<7B32sBBHBB")
    buf = bytearray(tl.ENTETE.size + 1 + tl.NB_VOITURES * 57)
    buf[:tl.ENTETE.size] = entete(tl.PAQUET_PARTICIPANTS, uid)
    buf[tl.ENTETE.size] = len(voitures)
    for i, v in enumerate(voitures):
        st.pack_into(buf, tl.ENTETE.size + 1 + i * 57, 1 if v["ia"] else 0, v["piloteId"], i, v["ecurie"], 0,
                     v["numero"], 0, v["nom"].encode("utf-8")[:31], 1, 1, 0, 1, 0)
    return bytes(buf)


def paquet_tours(uid, ordre, tour, grille):
    buf = bytearray(tl.ENTETE.size + tl.NB_VOITURES * 57 + 2)
    buf[:tl.ENTETE.size] = entete(tl.PAQUET_TOURS, uid)
    for pos, i in enumerate(ordre, start=1):
        struct.pack_into("<15B", buf, tl.ENTETE.size + i * 57 + 32,
                         pos, tour, 0, 1 if tour > 10 else 0, 0, 0, 0, 0, 0, 0, 0, grille[i], 4, 2, 0)
    return bytes(buf)


def paquet_classement(uid, resultats):
    st = struct.Struct("<7BIdBBB8s8s8s")
    buf = bytearray(tl.ENTETE.size + 1 + tl.NB_VOITURES * st.size)
    buf[:tl.ENTETE.size] = entete(tl.PAQUET_CLASSEMENT, uid)
    buf[tl.ENTETE.size] = len(resultats)
    for i, r in resultats.items():
        st.pack_into(buf, tl.ENTETE.size + 1 + i * st.size, r["pos"], r["tours"], r["grille"], r["points"],
                     r["arrets"], r["statut"], 2, r["meilleur"], r["total"], r["penalites"], r["nbPen"], 2,
                     bytes([18, 17]), bytes([18, 17]), bytes([20, r["tours"]]))
    return bytes(buf)


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--circuit", type=int, default=0)
    p.add_argument("--humains", default="Deluxiio,MaxRS,TomTom,Leo-F1")
    p.add_argument("--type", type=int, default=15, help="15 = course, 8 = qualif courte...")
    p.add_argument("--hors-ligne", action="store_true")
    p.add_argument("--tours", type=int, default=25)
    p.add_argument("--graine", type=int, default=None)
    p.add_argument("--port", type=int, default=20777)
    args = p.parse_args()

    hasard = random.Random(args.graine)
    uid = hasard.getrandbits(63)
    cible = ("127.0.0.1", args.port)
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)

    voitures = [{"ia": True, "nom": n, "ecurie": e, "piloteId": pid, "numero": 10 + k}
                for k, (n, e, pid) in enumerate(GRILLE_IA)]
    for siege, pseudo in zip(SIEGES_HUMAINS, [x for x in args.humains.split(",") if x]):
        voitures[siege].update(ia=False, nom=pseudo, piloteId=255)

    grille = {i: g for g, i in enumerate(hasard.sample(range(len(voitures)), len(voitures)), start=1)}
    envoyer = lambda paquet: sock.sendto(paquet, cible)

    envoyer(paquet_session(uid, args.circuit, args.type, not args.hors_ligne, args.tours))
    envoyer(paquet_participants(uid, voitures))
    for tour in range(1, 4):
        ordre = sorted(grille, key=lambda i: grille[i] + hasard.uniform(-3, 3))
        envoyer(paquet_tours(uid, ordre, tour, grille))
        envoyer(paquet_session(uid, args.circuit, args.type, not args.hors_ligne, args.tours))
        time.sleep(0.05)

    # Classement final : ordre de grille bousculé, quelques abandons
    forme = {i: grille[i] + hasard.gauss(0, 4) for i in grille}
    abandons = set(hasard.sample(sorted(grille), hasard.randint(0, 3)))
    ordre = sorted(grille, key=lambda i: (i in abandons, forme[i]))
    bareme = [25, 18, 15, 12, 10, 8, 6, 4, 2, 1]
    resultats = {}
    for pos, i in enumerate(ordre, start=1):
        abandon = i in abandons
        resultats[i] = {"pos": pos, "tours": hasard.randint(3, args.tours - 1) if abandon else args.tours,
                        "grille": grille[i], "points": 0 if abandon else (bareme[pos - 1] if pos <= 10 else 0),
                        "arrets": 1, "statut": 4 if abandon else 3,
                        "meilleur": 80000 + hasard.randint(0, 2500), "total": 2400 + pos * 3.7,
                        "penalites": 5 if hasard.random() < 0.1 else 0, "nbPen": 0}
        resultats[i]["nbPen"] = 1 if resultats[i]["penalites"] else 0
    envoyer(paquet_classement(uid, resultats))
    vainqueur = voitures[ordre[0]]["nom"]
    print(f"Séance simulée (uid {uid}) : circuit {args.circuit}, type {args.type}, vainqueur {vainqueur}")


if __name__ == "__main__":
    main()

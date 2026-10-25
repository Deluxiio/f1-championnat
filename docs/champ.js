// Calculs du championnat, partagés par la page publique et l'admin locale.
(function () {
  "use strict";

  // Identifiants de circuits du jeu (spécification UDP F1 25) -> [nom, code court]
  const CIRCUITS = {
    0: ["Australie", "AUS"], 2: ["Chine", "CHN"], 3: ["Bahreïn", "BHR"], 4: ["Espagne", "ESP"],
    5: ["Monaco", "MON"], 6: ["Canada", "CAN"], 7: ["Grande-Bretagne", "GBR"], 9: ["Hongrie", "HUN"],
    10: ["Belgique", "BEL"], 11: ["Italie", "ITA"], 12: ["Singapour", "SGP"], 13: ["Japon", "JPN"],
    14: ["Abu Dhabi", "ABU"], 15: ["États-Unis", "USA"], 16: ["Brésil", "BRA"], 17: ["Autriche", "AUT"],
    19: ["Mexique", "MEX"], 20: ["Azerbaïdjan", "AZE"], 26: ["Pays-Bas", "NED"],
    27: ["Émilie-Romagne", "EMI"], 29: ["Arabie saoudite", "KSA"], 30: ["Miami", "MIA"],
    31: ["Las Vegas", "LVG"], 32: ["Qatar", "QAT"], 39: ["Grande-Bretagne (inversé)", "GBR"],
    40: ["Autriche (inversé)", "AUT"], 41: ["Pays-Bas (inversé)", "NED"],
  };

  // Identifiants d'écuries du jeu -> [nom, couleur]
  const ECURIES = {
    0: ["Mercedes", "#27F4D2"], 1: ["Ferrari", "#E80020"], 2: ["Red Bull Racing", "#3671C6"],
    3: ["Williams", "#1868DB"], 4: ["Aston Martin", "#229971"], 5: ["Alpine", "#00A1E8"],
    6: ["Racing Bulls", "#6692FF"], 7: ["Haas", "#B6BABD"], 8: ["McLaren", "#FF8000"],
    9: ["Sauber", "#01C00E"], 41: ["F1 Générique"], 104: ["Écurie perso"], 129: ["Konnersport"],
    142: ["APXGP '24"], 154: ["APXGP"], 155: ["Konnersport '24"], 255: ["Mon écurie"],
  };

  const STATUTS = {
    fini: "Arrivé", abandon: "Abandon", dsq: "Disqualifié", nc: "Non classé", absent: "Absent / déco",
  };

  const nomCircuit = (id) => (CIRCUITS[id] ? CIRCUITS[id][0] : id == null ? "Circuit inconnu" : `Circuit n°${id}`);
  const codeCircuit = (id) => (CIRCUITS[id] ? CIRCUITS[id][1] : "???");
  const nomEcurie = (id) => (ECURIES[id] ? ECURIES[id][0] : id == null ? "—" : `Écurie n°${id}`);
  const couleurEcurie = (id) => (ECURIES[id] && ECURIES[id][1]) || "#8a8a8a";

  function formatTemps(ms) {
    if (!ms) return "—";
    const min = Math.floor(ms / 60000);
    const s = ((ms % 60000) / 1000).toFixed(3).padStart(6, "0");
    return `${min}:${s}`;
  }

  function lireTemps(texte) {
    const m = String(texte || "").trim().match(/^(?:(\d+):)?(\d{1,2}(?:[.,]\d{1,3})?)$/);
    if (!m) return null;
    return Math.round(((Number(m[1] || 0) * 60) + Number(m[2].replace(",", "."))) * 1000);
  }

  function pointsDe(r, bareme) {
    if (r.pointsForces !== undefined && r.pointsForces !== null && r.pointsForces !== "") {
      return Number(r.pointsForces);
    }
    if (r.statut !== "fini") return 0;
    return bareme[r.pos - 1] || 0;
  }

  function ordreCourses(saison) {
    const rang = (c) => (c.manche == null ? 1000 : c.manche);
    return [...saison.courses].sort((a, b) => rang(a) - rang(b) || String(a.date).localeCompare(String(b.date)));
  }

  function nomCourse(c, saison) {
    const m = saison.calendrier.find((x) => x.manche === c.manche);
    return m ? m.gp : nomCircuit(c.circuit);
  }

  // Départage façon F1 : points, puis nombre de victoires, de 2es places, etc.
  function comparer(a, b) {
    if (b.points !== a.points) return b.points - a.points;
    for (let k = 1; k < a.decompte.length; k++) {
      if (b.decompte[k] !== a.decompte[k]) return b.decompte[k] - a.decompte[k];
    }
    return a.nom.localeCompare(b.nom);
  }

  function statsVides() {
    return {
      courses: 0, victoires: 0, podiums: 0, dansLesPoints: 0, abandons: 0, meilleursTours: 0,
      meilleurResultat: null, sommePositions: 0, arrivees: 0, placesGagnees: 0, penalites: 0, nbPenalites: 0,
    };
  }

  // Les joueurs « partis » sont retirés des classements (leurs résultats restent dans les données) ; { avecPartis: true } les garde,
  // pour l'admin et les cartes, qui ont besoin de leur historique complet.
  function calculer(saison, options = {}) {
    const bareme = saison.bareme;
    const joueurs = new Map(saison.joueurs.map((j, i) => [`j:${j.id}`, { ...j, index: i }]));
    const courses = ordreCourses(saison).map((c, k) => ({
      ...c, index: k, code: codeCircuit(c.circuit), nomGp: nomCourse(c, saison),
    }));
    const pilotes = new Map();
    const ecuries = new Map();
    const evolution = [];

    const masque = (r) => !options.avecPartis && Boolean((joueurs.get(r.pilote) || {}).parti);
    for (const c of courses) {
      const meilleur = Math.min(...c.resultats.filter((r) => !masque(r)).map((r) => r.meilleurTour || Infinity));
      for (const r of c.resultats) {
        if (masque(r)) continue;
        let p = pilotes.get(r.pilote);
        if (!p) {
          const j = joueurs.get(r.pilote) || null;
          p = {
            id: r.pilote, nom: j ? j.nom : r.nom, joueur: j, ecurie: null, points: 0,
            resultats: new Array(courses.length).fill(null), decompte: new Array(23).fill(0), stats: statsVides(),
          };
          pilotes.set(r.pilote, p);
        }
        if (r.ecurie != null) p.ecurie = r.ecurie;
        const pts = pointsDe(r, bareme);
        const meilleurTour = Boolean(r.meilleurTour) && r.meilleurTour === meilleur;
        p.resultats[c.index] = { ...r, points: pts, meilleurTourCourse: meilleurTour };
        p.points += pts;
        const fini = r.statut === "fini";
        if (fini && r.pos < p.decompte.length) p.decompte[r.pos]++;

        const s = p.stats;
        s.courses++;
        if (fini) {
          s.arrivees++;
          s.sommePositions += r.pos;
          if (r.pos === 1) s.victoires++;
          if (r.pos <= 3) s.podiums++;
          if (s.meilleurResultat === null || r.pos < s.meilleurResultat) s.meilleurResultat = r.pos;
          if (r.grille > 0) s.placesGagnees += r.grille - r.pos;
        } else {
          s.abandons++;
        }
        if (pts > 0) s.dansLesPoints++;
        if (meilleurTour) s.meilleursTours++;
        s.penalites += r.penalites || 0;
        s.nbPenalites += r.nbPenalites || 0;

        if (r.ecurie != null) {
          let e = ecuries.get(r.ecurie);
          if (!e) {
            e = {
              id: r.ecurie, nom: nomEcurie(r.ecurie), couleur: couleurEcurie(r.ecurie), points: 0,
              pilotes: new Set(), resultats: new Array(courses.length).fill(null), decompte: new Array(23).fill(0),
            };
            ecuries.set(r.ecurie, e);
          }
          e.points += pts;
          e.resultats[c.index] = (e.resultats[c.index] || 0) + pts;
          e.pilotes.add(p);
          if (fini && r.pos < e.decompte.length) e.decompte[r.pos]++;
        }
      }
      const classement = [...pilotes.values()].sort(comparer);
      evolution.push({
        course: c,
        points: Object.fromEntries(classement.map((p) => [p.id, p.points])),
        rang: Object.fromEntries(classement.map((p, i) => [p.id, i + 1])),
      });
    }

    const classementPilotes = [...pilotes.values()].sort(comparer);
    classementPilotes.forEach((p, i) => { p.rang = i + 1; });
    const classementEcuries = [...ecuries.values()].sort(comparer);
    classementEcuries.forEach((e, i) => { e.rang = i + 1; });

    // Duels entre joueurs : qui a fini devant qui quand les deux étaient au départ
    const idsJoueurs = saison.joueurs.map((j) => `j:${j.id}`);
    const duels = {};
    for (const a of idsJoueurs) {
      duels[a] = {};
      for (const b of idsJoueurs) if (a !== b) duels[a][b] = { devant: 0, total: 0 };
    }
    for (const c of courses) {
      const res = new Map(c.resultats.map((r) => [r.pilote, r]));
      for (const a of idsJoueurs) {
        for (const b of idsJoueurs) {
          if (a === b) continue;
          const ra = res.get(a), rb = res.get(b);
          if (!ra || !rb || ra.statut === "absent" || rb.statut === "absent") continue;
          duels[a][b].total++;
          if (ra.pos < rb.pos) duels[a][b].devant++;
        }
      }
    }

    const joueursCalcules = saison.joueurs.map((j, i) => {
      const id = `j:${j.id}`;
      return pilotes.get(id) || {
        id, nom: j.nom, joueur: { ...j, index: i }, ecurie: null, points: 0, rang: null,
        resultats: new Array(courses.length).fill(null), decompte: new Array(23).fill(0), stats: statsVides(),
      };
    });

    const faites = new Set(courses.map((c) => c.manche).filter((m) => m != null));
    const prochaine = saison.calendrier.find((m) => !faites.has(m.manche)) || null;

    return {
      courses, classementPilotes, classementEcuries, evolution, duels,
      joueurs: joueursCalcules, joueursActifs: joueursCalcules.filter((p) => !p.joueur.parti), prochaine, nbManchesFaites: faites.size,
    };
  }

  window.Champ = {
    CIRCUITS, ECURIES, STATUTS, nomCircuit, codeCircuit, nomEcurie, couleurEcurie,
    formatTemps, lireTemps, pointsDe, ordreCourses, nomCourse, calculer,
  };
})();

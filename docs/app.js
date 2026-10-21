// Affichage de la page publique du championnat.
(function () {
  "use strict";

  const C = window.Champ;
  const etat = { saison: null, calc: null, maj: null, filtres: { pilotes: "tous", stats: "nous", evolution: "points" } };
  const SVG = "http://www.w3.org/2000/svg";

  // --- Petits utilitaires DOM (tout le texte passe par des nœuds texte) ---

  function ajouter(el, enfants) {
    for (const e of enfants.flat(Infinity)) {
      if (e === null || e === undefined || e === false) continue;
      el.appendChild(typeof e === "string" || typeof e === "number" ? document.createTextNode(String(e)) : e);
    }
    return el;
  }

  function h(tag, props, ...enfants) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v === null || v === undefined || v === false) continue;
      if (k === "style" && typeof v === "object") Object.assign(el.style, v);
      else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? "" : v);
    }
    return ajouter(el, enfants);
  }

  function s(tag, attrs, ...enfants) {
    const el = document.createElementNS(SVG, tag);
    for (const [k, v] of Object.entries(attrs || {})) if (v !== null && v !== undefined) el.setAttribute(k, v);
    return ajouter(el, enfants);
  }

  const vider = (id) => { const el = document.getElementById(id); el.replaceChildren(); return el; };
  const couleurJoueur = (j) => `var(--j${(j.index % 8) + 1})`;
  const pluriel = (n, mot) => `${n} ${mot}${n > 1 ? "s" : ""}`;
  const pts = (n) => `${n} pt${Math.abs(n) > 1 ? "s" : ""}`;

  function marqueur(p) {
    if (p.joueur) return h("span", { class: "pastille", style: { background: couleurJoueur(p.joueur) } });
    return h("span", { class: "trait-ecurie", style: { background: C.couleurEcurie(p.ecurie) } });
  }

  function vide(texte) {
    return h("div", { class: "vide" }, texte);
  }

  // --- En-tête ------------------------------------------------------------

  function rendreEntete() {
    const { saison, calc } = etat;
    document.title = saison.titre || "Championnat F1 25";
    document.getElementById("titre").textContent = saison.titre || "Championnat F1 25";
    document.getElementById("surtitre").textContent = `F1 25 · ${saison.saison || ""}`;
    const n = calc.courses.length;
    const total = saison.calendrier.length;
    let texte = n === 0 ? "Aucun GP couru pour l'instant" : `Après ${n} GP sur ${total}`;
    if (calc.prochaine) texte += ` · ${n === 0 ? "Premier" : "Prochain"} GP : ${calc.prochaine.gp}`;
    else if (n > 0) texte += " · Saison terminée";
    document.getElementById("sous-titre").textContent = texte;

    const cartes = vider("cartes");
    const leader = calc.classementPilotes[0];
    const joueurs = [...calc.joueurs].sort((a, b) => b.points - a.points || (a.rang || 99) - (b.rang || 99));
    for (const p of joueurs) {
      const dernier = [...p.resultats].reverse().find(Boolean);
      const derniereCourse = dernier ? calc.courses[p.resultats.lastIndexOf(dernier)] : null;
      let ecart = "";
      if (leader && n > 0) ecart = leader.id === p.id ? "Leader du championnat" : `à ${pts(leader.points - p.points)} de ${leader.nom}`;
      cartes.appendChild(h("div", { class: "carte-joueur", style: { "--couleur": couleurJoueur(p.joueur) } },
        h("div", { class: "nom" }, p.nom),
        h("div", { class: "rang" }, p.rang ? `${p.rang}${p.rang === 1 ? "er" : "e"} au général` : "Pas encore classé"),
        h("div", { class: "points" }, String(p.points), h("small", {}, p.points > 1 ? "pts" : "pt")),
        ecart && h("div", { class: "detail" }, ecart),
        dernier && h("div", { class: "detail" }, `Dernier GP (${derniereCourse.nomGp}) : ${libelleResultat(dernier)}`),
      ));
    }
  }

  function libelleResultat(r) {
    if (r.statut === "fini") return `P${r.pos}`;
    return { abandon: "abandon", dsq: "disqualifié", nc: "non classé", absent: "absent" }[r.statut] || r.statut;
  }

  // --- Classement pilotes ------------------------------------------------

  function caseResultat(r, course) {
    if (!r) return "";
    let classe, texte;
    if (r.statut === "absent") { classe = "absent"; texte = "—"; }
    else if (r.statut !== "fini") { classe = "ab"; texte = { abandon: "Ab", dsq: "DSQ", nc: "NC" }[r.statut] || "Ab"; }
    else {
      texte = String(r.pos);
      classe = r.pos === 1 ? "p1" : r.pos === 2 ? "p2" : r.pos === 3 ? "p3" : r.points > 0 ? "pts" : "hors";
    }
    if (r.meilleurTourCourse) classe += " mt";
    let titre = `${course.nomGp} : ${libelleResultat(r)} · ${pts(r.points)}`;
    if (r.grille) titre += ` · parti ${r.grille}e`;
    if (r.meilleurTourCourse) titre += ` · meilleur tour (${C.formatTemps(r.meilleurTour)})`;
    if (r.penalites) titre += ` · ${r.penalites} s de pénalité`;
    return h("span", { class: `case ${classe}`, title: titre }, texte);
  }

  function rendrePilotes() {
    const { calc } = etat;
    const zone = vider("table-pilotes");
    if (!calc.courses.length) {
      zone.appendChild(vide("Le classement apparaîtra après le premier Grand Prix."));
      return;
    }
    const liste = etat.filtres.pilotes === "nous" ? calc.classementPilotes.filter((p) => p.joueur) : calc.classementPilotes;
    const table = h("table", {},
      h("thead", {}, h("tr", {},
        h("th", { class: "colle" }, "Pilote"),
        h("th", { class: "num" }, "Pts"),
        h("th", { class: "masque-mobile" }, "Écurie"),
        calc.courses.map((c) => h("th", { class: "res", title: c.nomGp }, c.code)),
      )),
      h("tbody", {}, liste.map((p) => h("tr", { class: p.joueur ? "est-joueur" : null },
        h("td", { class: "colle" }, h("span", { class: "rang-cell" }, String(p.rang)),
          h("span", { class: "pilote" }, marqueur(p), p.nom)),
        h("td", { class: "num total" }, String(p.points)),
        h("td", { class: "masque-mobile ecurie-nom" }, C.nomEcurie(p.ecurie)),
        calc.courses.map((c, k) => h("td", { class: "res" }, caseResultat(p.resultats[k], c))),
      ))),
    );
    zone.appendChild(table);
  }

  // --- Classement constructeurs ------------------------------------------

  function rendreEcuries() {
    const { calc } = etat;
    const zone = vider("table-ecuries");
    if (!calc.courses.length) {
      zone.appendChild(vide("Le classement constructeurs apparaîtra après le premier Grand Prix."));
      return;
    }
    zone.appendChild(h("table", {},
      h("thead", {}, h("tr", {},
        h("th", { class: "colle" }, "Écurie"),
        h("th", { class: "num" }, "Pts"),
        h("th", { class: "masque-mobile" }, "Pilotes"),
        calc.courses.map((c) => h("th", { class: "res", title: c.nomGp }, c.code)),
      )),
      h("tbody", {}, calc.classementEcuries.map((e) => {
        const pilotes = [...e.pilotes];
        return h("tr", { class: pilotes.some((p) => p.joueur) ? "est-joueur" : null },
          h("td", { class: "colle" }, h("span", { class: "rang-cell" }, String(e.rang)),
            h("span", { class: "pilote" }, h("span", { class: "trait-ecurie", style: { background: e.couleur } }), e.nom)),
          h("td", { class: "num total" }, String(e.points)),
          h("td", { class: "masque-mobile ecurie-nom" }, pilotes.map((p) => p.nom).join(", ")),
          calc.courses.map((c, k) => h("td", { class: "res" }, e.resultats[k] === null ? "" : String(e.resultats[k]))),
        );
      })),
    ));
  }

  // --- Évolution (graphique) ---------------------------------------------

  function echelleRonde(max) {
    if (max <= 0) return { max: 10, pas: 5 };
    const brut = max / 5;
    const puissance = Math.pow(10, Math.floor(Math.log10(brut)));
    const pas = [1, 2, 2.5, 5, 10].map((m) => m * puissance).find((p) => p >= brut);
    return { max: Math.ceil(max / pas) * pas, pas };
  }

  function rendreEvolution() {
    const { calc } = etat;
    const zone = vider("graphique");
    const legende = vider("legende");
    const titre = document.getElementById("graphique-titre");
    if (document.getElementById("evolution").hidden) return;
    const n = calc.courses.length;
    const modeRang = etat.filtres.evolution === "rang";
    titre.textContent = modeRang
      ? "Position au classement général après chaque GP"
      : "Points cumulés après chaque GP";
    if (!n) { zone.appendChild(vide("Le graphique apparaîtra après le premier Grand Prix.")); return; }

    const series = calc.joueurs.map((p) => ({
      id: p.id, nom: p.nom, couleur: couleurJoueur(p.joueur),
      valeurs: calc.evolution.map((ev) => (modeRang ? ev.rang[p.id] : ev.points[p.id]) ?? (modeRang ? null : 0)),
    }));
    const leader = calc.classementPilotes[0];
    if (!modeRang && leader && !leader.joueur) {
      series.push({
        id: "leader", nom: "Leader", reference: true, couleur: "var(--ref)",
        valeurs: calc.evolution.map((ev) => Math.max(0, ...Object.values(ev.points))),
      });
    }

    for (const se of series) {
      legende.appendChild(h("span", {}, h("span", { class: "cle-ligne", style: { background: se.couleur } }),
        se.reference ? "Leader du championnat (toute la grille)" : se.nom));
    }

    const largeur = Math.max(zone.clientWidth, 280);
    const mobile = largeur < 560;
    const hauteur = mobile ? 260 : 320;
    const m = { haut: 12, droite: mobile ? 92 : 120, bas: 28, gauche: 34 };
    const lp = largeur - m.gauche - m.droite;
    const hp = hauteur - m.haut - m.bas;

    let yMin, yMax, ticks;
    if (modeRang) {
      const pire = Math.max(4, ...series.flatMap((se) => se.valeurs.filter((v) => v != null)));
      yMin = 1; yMax = pire;
      const pas = Math.max(1, Math.ceil((pire - 1) / 5));
      ticks = [];
      for (let t = 1; t <= pire; t += pas) ticks.push(t);
    } else {
      const ech = echelleRonde(Math.max(...series.flatMap((se) => se.valeurs)));
      yMin = 0; yMax = ech.max;
      ticks = [];
      for (let t = 0; t <= ech.max + 1e-9; t += ech.pas) ticks.push(t);
    }
    const x = (i) => m.gauche + (n === 1 ? lp / 2 : (i * lp) / (n - 1));
    const y = (v) => modeRang
      ? m.haut + ((v - yMin) / Math.max(1, yMax - yMin)) * hp
      : m.haut + hp - ((v - yMin) / (yMax - yMin)) * hp;

    const svg = s("svg", { viewBox: `0 0 ${largeur} ${hauteur}`, role: "img", tabindex: "0",
      "aria-label": titre.textContent });

    for (const t of ticks) {
      svg.appendChild(s("line", { x1: m.gauche, x2: m.gauche + lp, y1: y(t), y2: y(t), stroke: "var(--grille)", "stroke-width": 1 }));
      svg.appendChild(s("text", { x: m.gauche - 8, y: y(t) + 4, "text-anchor": "end", class: "axe-texte" },
        modeRang ? `P${t}` : String(t)));
    }
    const pasEtiquettes = Math.max(1, Math.ceil((n * 34) / lp));
    calc.courses.forEach((c, i) => {
      if (i % pasEtiquettes !== 0 && i !== n - 1) return;
      svg.appendChild(s("text", { x: x(i), y: hauteur - 8, "text-anchor": "middle", class: "axe-texte" }, c.code));
    });

    // Lignes (la référence d'abord, en dessous)
    const ordreDessin = [...series].sort((a, b) => (b.reference ? 1 : 0) - (a.reference ? 1 : 0));
    for (const se of ordreDessin) {
      let d = "";
      se.valeurs.forEach((v, i) => {
        if (v == null) return;
        d += `${d ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
      });
      if (n > 1) {
        svg.appendChild(s("path", { d, fill: "none", stroke: se.couleur, "stroke-width": se.reference ? 1.5 : 2,
          "stroke-linejoin": "round", "stroke-linecap": "round" }));
      }
      const iFin = se.valeurs.map((v) => v != null).lastIndexOf(true);
      if (iFin >= 0) {
        svg.appendChild(s("circle", { cx: x(iFin), cy: y(se.valeurs[iFin]), r: se.reference ? 3 : 4,
          fill: se.couleur, stroke: "var(--surface)", "stroke-width": 2 }));
      }
    }

    // Étiquettes directes en bout de ligne, avec traits de rappel si elles se chevauchent
    const etiquettes = series.map((se) => {
      const iFin = se.valeurs.map((v) => v != null).lastIndexOf(true);
      return iFin < 0 ? null : { se, iFin, yLigne: y(se.valeurs[iFin]), yTexte: y(se.valeurs[iFin]) };
    }).filter(Boolean).sort((a, b) => a.yLigne - b.yLigne);
    const ecartMin = 26;
    for (let i = 1; i < etiquettes.length; i++) {
      etiquettes[i].yTexte = Math.max(etiquettes[i].yTexte, etiquettes[i - 1].yTexte + ecartMin);
    }
    const debordement = etiquettes.length ? etiquettes[etiquettes.length - 1].yTexte - (hauteur - m.bas - 8) : 0;
    if (debordement > 0) etiquettes.forEach((e) => { e.yTexte -= debordement; });
    const xTexte = m.gauche + lp + 14;
    for (const e of etiquettes) {
      const nom = e.se.reference ? "Leader" : e.se.nom;
      const court = nom.length > (mobile ? 9 : 14) ? `${nom.slice(0, mobile ? 8 : 13)}…` : nom;
      const valeur = modeRang ? `P${e.se.valeurs[e.iFin]}` : pts(e.se.valeurs[e.iFin]);
      if (Math.abs(e.yTexte - e.yLigne) > 2 || x(e.iFin) < m.gauche + lp - 1) {
        svg.appendChild(s("path", { d: `M${x(e.iFin) + 6},${e.yLigne} L${xTexte - 4},${e.yTexte}`,
          stroke: "var(--axe)", "stroke-width": 1, fill: "none" }));
      }
      svg.appendChild(s("text", { x: xTexte, y: e.yTexte - 1, class: "etiquette" }, court));
      svg.appendChild(s("text", { x: xTexte, y: e.yTexte + 12, class: "etiquette-val" }, valeur));
    }

    // Survol : réticule vertical + infobulle avec toutes les séries
    const reticule = s("line", { y1: m.haut, y2: m.haut + hp, stroke: "var(--axe)", "stroke-width": 1, visibility: "hidden" });
    const points = s("g", { visibility: "hidden" });
    svg.appendChild(reticule);
    svg.appendChild(points);
    const zoneSurvol = s("rect", { x: m.gauche - 10, y: m.haut, width: lp + 20, height: hp, fill: "transparent" });
    svg.appendChild(zoneSurvol);
    const bulle = document.getElementById("infobulle");

    function montrer(i, cx, cy) {
      reticule.setAttribute("x1", x(i)); reticule.setAttribute("x2", x(i));
      reticule.setAttribute("visibility", "visible");
      points.replaceChildren();
      for (const se of series) {
        const v = se.valeurs[i];
        if (v == null) continue;
        points.appendChild(s("circle", { cx: x(i), cy: y(v), r: 4, fill: se.couleur, stroke: "var(--surface)", "stroke-width": 2 }));
      }
      points.setAttribute("visibility", "visible");
      const c = calc.courses[i];
      const lignes = series.filter((se) => se.valeurs[i] != null)
        .sort((a, b) => (modeRang ? a.valeurs[i] - b.valeurs[i] : b.valeurs[i] - a.valeurs[i]));
      bulle.replaceChildren(
        h("div", { class: "titre-bulle" }, `${c.manche ? `Manche ${c.manche} · ` : ""}${c.nomGp}`),
        lignes.map((se) => h("div", { class: "ligne-bulle" },
          h("span", { class: "cle-ligne", style: { background: se.couleur } }),
          h("strong", {}, modeRang ? `P${se.valeurs[i]}` : String(se.valeurs[i])),
          h("span", {}, se.reference ? "Leader du championnat" : se.nom))),
      );
      bulle.hidden = false;
      const r = bulle.getBoundingClientRect();
      let left = cx + 16;
      if (left + r.width > window.innerWidth - 8) left = cx - r.width - 16;
      bulle.style.left = `${Math.max(8, left)}px`;
      bulle.style.top = `${Math.min(window.innerHeight - r.height - 8, Math.max(8, cy - r.height / 2))}px`;
    }
    function cacher() {
      reticule.setAttribute("visibility", "hidden");
      points.setAttribute("visibility", "hidden");
      bulle.hidden = true;
    }
    function indexDepuis(evt) {
      const r = svg.getBoundingClientRect();
      const px = ((evt.clientX - r.left) / r.width) * largeur;
      return n === 1 ? 0 : Math.max(0, Math.min(n - 1, Math.round(((px - m.gauche) / lp) * (n - 1))));
    }
    zoneSurvol.addEventListener("pointermove", (evt) => montrer(indexDepuis(evt), evt.clientX, evt.clientY));
    zoneSurvol.addEventListener("pointerdown", (evt) => montrer(indexDepuis(evt), evt.clientX, evt.clientY));
    zoneSurvol.addEventListener("pointerleave", cacher);
    let iClavier = n - 1;
    svg.addEventListener("keydown", (evt) => {
      if (evt.key !== "ArrowLeft" && evt.key !== "ArrowRight") return;
      evt.preventDefault();
      iClavier = Math.max(0, Math.min(n - 1, iClavier + (evt.key === "ArrowRight" ? 1 : -1)));
      const r = svg.getBoundingClientRect();
      montrer(iClavier, r.left + (x(iClavier) / largeur) * r.width, r.top + r.height / 2);
    });
    svg.addEventListener("blur", cacher);

    zone.appendChild(svg);
  }

  // --- Duels ---------------------------------------------------------------

  function rendreDuels() {
    const { calc } = etat;
    const liste = vider("liste-duels");
    const matrice = vider("matrice-duels");
    const joueurs = calc.joueurs;
    if (!calc.courses.length) {
      liste.appendChild(vide("Les duels apparaîtront après le premier Grand Prix."));
      return;
    }
    for (let i = 0; i < joueurs.length; i++) {
      for (let k = i + 1; k < joueurs.length; k++) {
        const a = joueurs[i], b = joueurs[k];
        const da = calc.duels[a.id][b.id], db = calc.duels[b.id][a.id];
        const ecart = a.points - b.points;
        liste.appendChild(h("div", { class: "duel" },
          h("div", { class: "duel-ligne" },
            h("span", { class: "duel-nom" }, h("span", { class: "pastille", style: { background: couleurJoueur(a.joueur) } }), h("span", {}, a.nom)),
            h("span", { class: "duel-score" }, `${da.devant} – ${db.devant}`),
            h("span", { class: "duel-nom" }, h("span", {}, b.nom), h("span", { class: "pastille", style: { background: couleurJoueur(b.joueur) } })),
          ),
          h("div", { class: "duel-barre", "aria-hidden": "true" },
            da.total === 0 ? h("span", { class: "neutre" }) : [
              da.devant ? h("span", { style: { flex: String(da.devant), background: couleurJoueur(a.joueur) } }) : null,
              db.devant ? h("span", { style: { flex: String(db.devant), background: couleurJoueur(b.joueur) } }) : null,
            ]),
          h("div", { class: "duel-detail" },
            da.total === 0 ? "Pas encore de course ensemble" : `${pluriel(da.total, "course")} ensemble`,
            " · ",
            ecart === 0 ? "égalité de points" : `${ecart > 0 ? a.nom : b.nom} devant de ${pts(Math.abs(ecart))}`),
        ));
      }
    }
    matrice.appendChild(h("table", {},
      h("thead", {}, h("tr", {}, h("th", { class: "colle" }, "Devant ↓ / derrière →"),
        joueurs.map((b) => h("th", { class: "centre" }, b.nom)))),
      h("tbody", {}, joueurs.map((a) => h("tr", {},
        h("td", { class: "colle" }, h("span", { class: "pilote" }, h("span", { class: "pastille", style: { background: couleurJoueur(a.joueur) } }), a.nom)),
        joueurs.map((b) => {
          if (a.id === b.id) return h("td", { class: "centre" }, "·");
          const d = calc.duels[a.id][b.id];
          return h("td", { class: "centre", title: `${a.nom} a fini devant ${b.nom} ${d.devant} fois sur ${d.total}` },
            d.total ? `${d.devant} / ${d.total}` : "—");
        }),
      ))),
    ));
  }

  // --- Stats ---------------------------------------------------------------

  function rendreStats() {
    const { calc } = etat;
    const zone = vider("table-stats");
    if (!calc.courses.length) {
      zone.appendChild(vide("Les stats apparaîtront après le premier Grand Prix."));
      return;
    }
    const liste = etat.filtres.stats === "nous" ? calc.joueurs.slice().sort((a, b) => (a.rang || 99) - (b.rang || 99))
      : calc.classementPilotes;
    const colonnes = [
      ["Courses", (st) => st.courses],
      ["Victoires", (st) => st.victoires],
      ["Podiums", (st) => st.podiums],
      ["Dans les points", (st) => st.dansLesPoints],
      ["Abandons", (st) => st.abandons],
      ["Meilleurs tours", (st) => st.meilleursTours],
      ["Meilleur résultat", (st) => (st.meilleurResultat ? `P${st.meilleurResultat}` : "—")],
      ["Arrivée moyenne", (st) => (st.arrivees ? (st.sommePositions / st.arrivees).toFixed(1).replace(".", ",") : "—")],
      ["Places gagnées", (st) => (st.placesGagnees > 0 ? `+${st.placesGagnees}` : String(st.placesGagnees))],
      ["Pénalités", (st) => (st.nbPenalites ? `${st.nbPenalites} (${st.penalites} s)` : "0")],
    ];
    zone.appendChild(h("table", {},
      h("thead", {}, h("tr", {}, h("th", { class: "colle" }, "Pilote"),
        colonnes.map(([nom]) => h("th", { class: "num" }, nom)))),
      h("tbody", {}, liste.map((p) => h("tr", { class: p.joueur && etat.filtres.stats === "tous" ? "est-joueur" : null },
        h("td", { class: "colle" }, h("span", { class: "rang-cell" }, p.rang ? String(p.rang) : "–"),
          h("span", { class: "pilote" }, marqueur(p), p.nom)),
        colonnes.map(([, f]) => h("td", { class: "num" }, String(f(p.stats)))),
      ))),
    ));
  }

  // --- Calendrier ------------------------------------------------------------

  function rendreCalendrier() {
    const { saison, calc } = etat;
    const liste = vider("liste-calendrier");
    const pilotes = new Map(calc.classementPilotes.map((p) => [p.id, p]));
    const ligneVainqueur = (course) => {
      const items = [];
      const premier = course.resultats.find((r) => r.pos === 1);
      if (premier) {
        const p = pilotes.get(premier.pilote);
        items.push(h("div", { class: "gp-ligne" }, "Vainqueur : ", h("strong", {}, p ? p.nom : premier.nom)));
      }
      const nous = course.resultats.filter((r) => r.pilote.startsWith("j:") && r.statut === "fini").sort((a, b) => a.pos - b.pos)[0];
      if (nous && nous.pos !== 1) {
        const p = pilotes.get(nous.pilote);
        items.push(h("div", { class: "gp-ligne" }, p && p.joueur ? h("span", { class: "pastille", style: { background: couleurJoueur(p.joueur) } }) : null,
          "Meilleur d'entre nous : ", h("strong", {}, p ? p.nom : nous.nom), ` (P${nous.pos})`));
      }
      return items;
    };
    for (const m of saison.calendrier) {
      const course = calc.courses.find((c) => c.manche === m.manche);
      const prochain = calc.prochaine && calc.prochaine.manche === m.manche;
      liste.appendChild(h("li", { class: `gp${course ? "" : prochain ? " prochain" : " a-venir"}` },
        h("div", { class: "gp-tete" },
          h("span", { class: "gp-manche" }, `Manche ${m.manche}`),
          course ? h("span", { class: "badge" }, "Couru") : prochain ? h("span", { class: "badge" }, "Prochain GP") : null),
        h("div", { class: "gp-nom" }, m.gp),
        course ? ligneVainqueur(course) : null,
      ));
    }
    for (const course of calc.courses.filter((c) => c.manche == null)) {
      liste.appendChild(h("li", { class: "gp" },
        h("div", { class: "gp-tete" }, h("span", { class: "gp-manche" }, "Hors calendrier")),
        h("div", { class: "gp-nom" }, course.nomGp), ligneVainqueur(course)));
    }
  }

  function rendrePied() {
    const pied = vider("pied");
    if (etat.saison.maj) {
      const d = new Date(etat.saison.maj);
      pied.appendChild(document.createTextNode(
        `Mis à jour le ${d.toLocaleDateString("fr-FR")} à ${d.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })} · Résultats enregistrés automatiquement par la télémétrie de F1 25`));
    }
  }

  function rendre() {
    etat.calc = C.calculer(etat.saison);
    rendreEntete();
    rendrePilotes();
    rendreEcuries();
    rendreEvolution();
    rendreDuels();
    rendreStats();
    rendreCalendrier();
    rendrePied();
  }

  // --- Onglets, filtres, chargement ------------------------------------------

  function afficherOnglet() {
    const ids = ["pilotes", "ecuries", "evolution", "duels", "stats", "calendrier"];
    const id = ids.includes(location.hash.slice(1)) ? location.hash.slice(1) : "pilotes";
    for (const autre of ids) document.getElementById(autre).hidden = autre !== id;
    for (const a of document.querySelectorAll(".onglets a")) {
      a.setAttribute("aria-selected", a.getAttribute("href") === `#${id}` ? "true" : "false");
    }
    if (id === "evolution" && etat.calc) rendreEvolution();
  }

  document.querySelectorAll(".onglets a").forEach((a) => a.addEventListener("click", (evt) => {
    evt.preventDefault();
    history.replaceState(null, "", a.getAttribute("href"));
    afficherOnglet();
  }));
  window.addEventListener("hashchange", afficherOnglet);

  document.querySelectorAll(".bascule").forEach((groupe) => {
    groupe.addEventListener("click", (evt) => {
      const bouton = evt.target.closest("button");
      if (!bouton) return;
      for (const b of groupe.querySelectorAll("button")) b.setAttribute("aria-pressed", b === bouton ? "true" : "false");
      etat.filtres[groupe.dataset.filtre] = bouton.dataset.valeur;
      if (etat.calc) rendre();
    });
  });

  let largeurPrecedente = 0;
  window.addEventListener("resize", () => {
    if (window.innerWidth === largeurPrecedente || !etat.calc) return;
    largeurPrecedente = window.innerWidth;
    rendreEvolution();
  });

  async function charger() {
    try {
      const reponse = await fetch(`data/saison.json?t=${Date.now()}`, { cache: "no-store" });
      const saison = await reponse.json();
      if (saison.maj && saison.maj === etat.maj) return;
      etat.saison = saison;
      etat.maj = saison.maj || null;
      rendre();
    } catch (e) {
      if (!etat.saison) document.getElementById("sous-titre").textContent = "Impossible de charger les résultats.";
    }
  }

  afficherOnglet();
  charger();
  // Pendant une soirée de course, la page se met à jour toute seule
  setInterval(() => { if (!document.hidden) charger(); }, 60000);
})();

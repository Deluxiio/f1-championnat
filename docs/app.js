// Écrans du classement : accueil (tableau de bord), classement (pilotes, constructeurs, évolution, duels, stats) et courses.
// Dialogue avec le routeur (site.js) et le jeu de cartes (cartes.js) par événements seulement :
//   écoute  site:route { id, section, vue }   cartes:etat { moi, pronos, … }
//   émet    champ:donnees { saison, calc }    (à chaque rendu des données ; window.Championnat.donnees() donne la même chose)
(function () {
  "use strict";

  const C = window.Champ;
  const etat = {
    saison: null, calc: null, ctx: null, maj: null,
    cartes: null,             // dernier cartes:etat reçu (null tant que le jeu n'a pas répondu)
    cartesTardives: false,    // le jeu n'a pas répondu à temps : la carte « Mes cartes » le dit
    filtres: { pilotes: "tous", stats: "nous", evolution: "points" },
    minuterie: null,
  };
  const SVG = "http://www.w3.org/2000/svg";
  const NB_COURSES_ACCUEIL = 7;   // le classement de l'accueil montre les dernières courses seulement

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
      if (k === "style" && typeof v === "object") {
        for (const [p, valeur] of Object.entries(v)) {
          if (p.startsWith("--")) el.style.setProperty(p, valeur); else el.style[p] = valeur;
        }
      } else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? "" : v);
    }
    return ajouter(el, enfants);
  }

  function s(tag, attrs, ...enfants) {
    const el = document.createElementNS(SVG, tag);
    for (const [k, v] of Object.entries(attrs || {})) if (v !== null && v !== undefined) el.setAttribute(k, v);
    return ajouter(el, enfants);
  }

  const $ = (id) => document.getElementById(id);
  const vider = (id) => { const el = $(id); el.replaceChildren(); return el; };
  // Remplit un élément (les null et les tableaux imbriqués sont acceptés ; replaceChildren() écrirait « null » en toutes lettres)
  const remplir = (zone, ...enfants) => { zone.replaceChildren(); return ajouter(zone, enfants); };
  const icone = (id) => s("svg", { class: "ic", "aria-hidden": "true" }, s("use", { href: `#${id}` }));

  // --- Formats ---

  const couleurJoueur = (j) => `var(--j${(j.index % 8) + 1})`;
  const pluriel = (n, mot, forme) => `${n} ${n > 1 ? (forme || `${mot}s`) : mot}`;
  const pts = (n) => `${n} pt${Math.abs(n) > 1 ? "s" : ""}`;
  const ordinal = (n) => (n === 1 ? "1er" : `${n}e`);
  const ecartTexte = (n) => (n > 0 ? `+${n}` : n < 0 ? `−${-n}` : "—");   // vrai signe moins (U+2212)
  const coursesDisputees = (n) => (n ? `${pluriel(n, "course")} disputée${n > 1 ? "s" : ""}` : "Aucune course disputée");

  function dureeCourte(secondes) {
    const sec = Math.max(0, Math.ceil(secondes));
    const heures = Math.floor(sec / 3600), minutes = Math.floor((sec % 3600) / 60);
    return heures ? `${heures} h ${String(minutes).padStart(2, "0")} min` : `${minutes}:${String(sec % 60).padStart(2, "0")}`;
  }

  function libelleResultat(r) {
    if (r.statut === "fini") return `P${r.pos}`;
    return { abandon: "abandon", dsq: "disqualifié", nc: "non classé", absent: "absent" }[r.statut] || r.statut;
  }

  function vide(texte) {
    return h("div", { class: "vide" }, texte);
  }

  // --- Contexte du championnat (recalculé avec les données) ---

  function preparerContexte() {
    return { joueurs: new Map(etat.calc.joueurs.map((p) => [p.id, p.joueur])) };
  }
  const joueurDe = (id) => etat.ctx.joueurs.get(id) || null;
  const joueurActif = (id) => { const j = joueurDe(id); return j && !j.parti ? j : null; };   // les joueurs partis n'ont plus de couleur
  const nomResultat = (r) => { const j = joueurDe(r.pilote); return j ? j.nom : r.nom || r.pilote; };
  const joueursTries = () => [...etat.calc.joueursActifs].sort((a, b) => b.points - a.points || (a.rang || 99) - (b.rang || 99));
  const definirTitre = (id, titre) => { if (window.Site) window.Site.definirTitre(id, titre); };

  function pastille(j) {
    return j ? h("i", { class: "pt", style: { background: couleurJoueur(j) } }) : null;
  }
  function nomAvecPastille(r) {
    return h("span", { class: "cl-nm" }, pastille(joueurActif(r.pilote)), nomResultat(r));
  }

  // --- Pronostics du prochain GP, d'après le jeu de cartes ---

  function etatPronos() {
    const c = etat.cartes, m = etat.calc.prochaine;
    const p = c && c.pronosVisibles ? c.pronos : null;
    // En démo, le GP à pronostiquer est inventé et ne suit pas le calendrier : on le prend tel quel.
    if (!p || !m || (p.manche !== m.manche && !c.demo)) return null;
    const aParie = p.aParie || {};
    const actifs = etat.calc.joueursActifs;
    const ouvert = p.statut === "ouvert" && p.actif !== false;
    return {
      ouvert, k: actifs.filter((j) => aParie[j.joueur.id]).length, n: actifs.length,
      moi: !!(c.moi && aParie[c.moi.id]),
    };
  }

  function puceEtatPronos(pr) {
    return pr.ouvert
      ? h("span", { class: "puce puce-ok" }, h("i"), "Pronostics ouverts")
      : h("span", { class: "puce puce-or" }, "Pronostics fermés");
  }

  // --- Éléments partagés : cases de résultat, légende, barre de saison, courbes ---

  function caseResultat(r, course) {
    if (!r) return h("span", { class: "r rx", title: `${course.nomGp} : pas au départ` }, "–");
    let classe, texte;
    if (r.statut === "absent") { classe = "rx"; texte = "–"; }
    else if (r.statut !== "fini") { classe = "rab"; texte = { abandon: "Ab", dsq: "DSQ", nc: "NC" }[r.statut] || "Ab"; }
    else {
      texte = String(r.pos);
      classe = r.pos === 1 ? "r1" : r.pos === 2 ? "r2" : r.pos === 3 ? "r3" : r.points > 0 ? "rp" : "rh";
    }
    if (r.meilleurTourCourse) classe += " mt";
    let titre = `${course.nomGp} : ${libelleResultat(r)} · ${pts(r.points)}`;
    if (r.grille) titre += ` · parti ${r.grille}e`;
    if (r.meilleurTourCourse) titre += ` · meilleur tour (${C.formatTemps(r.meilleurTour)})`;
    if (r.penalites) titre += ` · ${r.penalites} s de pénalité`;
    return h("span", { class: `r ${classe}`, title: titre }, texte);
  }

  function legendeCases() {
    const l = (chips, texte) => h("span", { class: "cl-l" }, chips, texte);
    return h("div", { class: "cl-legende-cases", role: "group", "aria-label": "Légende des cases" },
      l(h("span", { class: "r r1" }, "1"), "Victoire"),
      l([h("span", { class: "r r2" }, "2"), h("span", { class: "r r3" }, "3")], "Podium"),
      l(h("span", { class: "r rp" }, "7"), "Dans les points"),
      l(h("span", { class: "r rh" }, "14"), "Hors points"),
      l(h("span", { class: "r rab" }, "Ab"), "Abandon"),
      l(h("span", { class: "r rp mt" }, "5"), "Meilleur tour"),
      l(h("span", { class: "r rx" }, "–"), "Absent"),
    );
  }

  function barreSaison() {
    const { saison, calc } = etat;
    const total = saison.calendrier.length, n = calc.courses.length;
    if (!total) return null;
    const faits = new Set(calc.courses.map((c) => c.manche).filter((m) => m != null));
    return h("div", { class: "cl-saison-bloc" },
      h("div", { class: "cl-saison", role: "img", "aria-label": `Saison : ${coursesDisputees(n).toLowerCase()} sur ${total}` },
        saison.calendrier.map((m) => h("i", { class: faits.has(m.manche) ? "f" : calc.prochaine && calc.prochaine.manche === m.manche ? "p" : null }))),
      h("div", { class: "cl-saison-lg n" }, h("span", {}, coursesDisputees(n)), h("span", {}, `${total} au calendrier`)));
  }

  function courbe(valeurs, max, couleur) {
    const n = valeurs.length, x0 = 4, x1 = 100, yBas = 28, yHaut = 4;
    const x = (i) => (n === 1 ? (x0 + x1) / 2 : x0 + (i * (x1 - x0)) / (n - 1));
    const y = (v) => yBas - (max > 0 ? (v / max) * (yBas - yHaut) : 0);
    return s("svg", { class: "cl-spark", viewBox: "0 0 104 32", role: "img", "aria-label": `Points après chaque GP : ${valeurs.join(", ")}` },
      n > 1 ? s("polyline", { points: valeurs.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" "), stroke: couleur }) : null,
      s("circle", { cx: x(n - 1).toFixed(1), cy: y(valeurs[n - 1]).toFixed(1), r: 3.5, fill: couleur }));
  }

  // --- Titres de page ----------------------------------------------------------

  function phraseAccueil() {
    const { saison, calc } = etat;
    const n = calc.courses.length, total = saison.calendrier.length, prochaine = calc.prochaine;
    const rdv = prochaine ? `${n ? "Prochain" : "Premier"} rendez-vous : manche ${prochaine.manche} sur ${total}, ${prochaine.gp}.` : "";
    if (!n) return { titre: "Le championnat n'a pas encore commencé", sousTitre: rdv };
    const [premier, second] = calc.classementPilotes;
    const nos = calc.joueursActifs.filter((p) => p.rang).sort((a, b) => a.rang - b.rang);
    if (!premier) return { titre: `Après ${n} GP`, sousTitre: rdv };
    if (!prochaine) {
      const meilleur = !premier.joueur && nos.length ? ` Meilleur d'entre nous : ${nos[0].nom}, ${ordinal(nos[0].rang)}.` : "";
      return { titre: `Saison terminée : ${premier.nom} est champion`, sousTitre: `${coursesDisputees(n)}.${meilleur}` };
    }
    let titre;
    if (premier.joueur) {
      const ecart = second ? premier.points - second.points : 0;
      titre = !second ? `Après ${n} GP, ${premier.nom} mène le championnat`
        : ecart > 0 ? `Après ${n} GP, ${premier.nom} mène de ${pluriel(ecart, "point")}`
          : `Après ${n} GP, ${premier.nom} et ${second.nom} sont à égalité`;
    } else if (nos.length > 1) titre = `Après ${n} GP, ${nos[0].nom} est le meilleur d'entre nous`;
    else if (nos.length === 1) titre = `Après ${n} GP, ${nos[0].nom} est ${ordinal(nos[0].rang)} au général`;
    else titre = `Après ${n} GP, ${premier.nom} mène le championnat`;
    return { titre, sousTitre: rdv };
  }

  function majTitres() {
    const { saison, calc } = etat;
    const n = calc.courses.length, total = saison.calendrier.length;
    const apres = n ? `Après ${n} GP${total ? ` sur ${total}` : ""}` : "";
    definirTitre("accueil", phraseAccueil());
    definirTitre("pilotes", { sousTitre: apres });
    definirTitre("ecuries", { sousTitre: apres });
    definirTitre("stats", { sousTitre: apres });
    definirTitre("evolution", { sousTitre: apres });
    definirTitre("duels", { sousTitre: "Courses où chacun a fini devant l'autre, quand les deux étaient au départ." });
    definirTitre("courses", { sousTitre: `${coursesDisputees(n)}${total ? ` sur ${total}` : ""}` });
  }

  // --- Accueil : tableau de bord -------------------------------------------------

  function texteEcart(p) {
    const [premier, second] = etat.calc.classementPilotes;
    if (!p.rang || !premier) return [];
    // Sur ordinateur « Leader · +16 sur Leclerc » ; sur téléphone le rang remplace « Leader » (« 1er · +16 sur Leclerc »)
    if (p.rang === 1) {
      const leader = h("span", { class: "cl-d-seul" }, "Leader");
      if (!second) return [leader];
      const e = p.points - second.points;
      return e > 0 ? [leader, h("span", { class: "cl-d-seul" }, " · "), h("b", { class: "n" }, `+${e}`), ` sur ${second.nom}`] : [leader, h("span", { class: "cl-d-seul" }, " · "), `à égalité avec ${second.nom}`];
    }
    const e = premier.points - p.points;
    return e > 0 ? [h("b", { class: "n" }, `−${e}`), " du leader"] : ["À égalité avec le leader"];
  }

  function carteKpi(p, max, moiId) {
    const serie = etat.calc.evolution.map((ev) => ev.points[p.id] ?? 0);
    const couleur = couleurJoueur(p.joueur);
    return h("article", { class: "bloc cl-kpi" },
      h("span", { class: "cl-kpi-nom" }, pastille(p.joueur), p.nom, p.joueur.id === moiId ? h("span", { class: "cl-moi" }, "Moi") : null),
      h("span", { class: "cl-kpi-rang n" }, p.rang ? `${ordinal(p.rang)} au général` : "Pas encore classé"),
      h("div", { class: "cl-kpi-pts n" }, String(p.points), " ", h("small", {}, p.points > 1 ? "pts" : "pt")),
      serie.length ? courbe(serie, max, couleur) : null,
      h("p", { class: "cl-kpi-ecart n" }, p.rang ? h("span", { class: "cl-m-seul" }, `${ordinal(p.rang)} · `) : null, texteEcart(p)));
  }

  function rendreKpis() {
    const joueurs = joueursTries();
    const moiId = etat.cartes && etat.cartes.moi ? etat.cartes.moi.id : null;
    const max = Math.max(1, ...joueurs.map((p) => p.points));
    $("cl-kpis").hidden = !joueurs.length;
    remplir($("cl-kpis-liste"), joueurs.map((p) => carteKpi(p, max, moiId)));
  }

  function actionsGp(pr, avecCalendrier) {
    const liens = [];
    if (pr) {
      liens.push(h("a", { class: pr.ouvert ? "btn btn-p" : "btn btn-s", href: "#/cartes/pronostics" },
        pr.ouvert ? (pr.moi ? "Modifier mon pronostic" : "Faire mon pronostic") : "Voir les pronostics"));
    }
    if (avecCalendrier) liens.push(h("a", { class: "btn btn-s", href: "#/courses" }, "Calendrier"));
    return liens;
  }

  function rendreGp() {
    const { saison, calc } = etat;
    const zone = $("cl-gp");
    const n = calc.courses.length, total = saison.calendrier.length, m = calc.prochaine;
    zone.hidden = false;
    if (m) {
      const pr = etatPronos();
      remplir(zone,
        h("div", { class: "cl-haut" }, h("span", { class: "sur rouge", id: "cl-gp-sur" }, n ? "Prochain Grand Prix" : "Premier Grand Prix"), h("span", { class: "cl-note n" }, `Manche ${m.manche} / ${total}`)),
        h("h2", { class: "cl-gp-nom", id: "cl-gp-titre" }, m.gp),
        pr ? h("div", { class: "cl-gp-etat" }, puceEtatPronos(pr), pr.ouvert ? h("span", { class: "n" }, `${pr.k} / ${pr.n} ont parié`) : null) : null,
        pr && pr.ouvert ? h("p", { class: "cl-gp-ligne" }, "Devinez le meilleur d'entre vous et l'ordre d'arrivée. Aucune mise, rien à perdre.") : null,
        h("div", { class: "cl-gp-actions" }, actionsGp(pr, true)),
        h("div", { class: "cl-gp-bas" }, barreSaison()));
      return;
    }
    if (n) {
      const [premier] = calc.classementPilotes;
      remplir(zone,
        h("div", { class: "cl-haut" }, h("span", { class: "sur rouge", id: "cl-gp-sur" }, "Saison terminée"), h("span", { class: "cl-note n" }, `${total || n} courses`)),
        h("h2", { class: "cl-gp-nom", id: "cl-gp-titre" }, "Saison terminée"),
        premier ? h("p", { class: "cl-gp-ligne" }, `${premier.nom} remporte le championnat avec ${pts(premier.points)}.`) : null,
        h("div", { class: "cl-gp-actions" },
          h("a", { class: "btn btn-p", href: "#/classement" }, "Voir le classement"), h("a", { class: "btn btn-s", href: "#/courses" }, "Calendrier")),
        h("div", { class: "cl-gp-bas" }, barreSaison()));
      return;
    }
    remplir(zone,
      h("div", { class: "cl-haut" }, h("span", { class: "sur", id: "cl-gp-sur" }, "Calendrier")),
      h("h2", { class: "cl-gp-nom", id: "cl-gp-titre" }, "À venir"),
      h("p", { class: "cl-gp-ligne" }, "Le calendrier de la saison n'est pas encore défini."));
  }

  function rendreDerniere() {
    const { saison, calc } = etat;
    const zone = $("cl-der");
    const course = calc.courses[calc.courses.length - 1];
    if (!course) {
      remplir(zone,
        h("div", { class: "cl-haut" }, h("span", { class: "sur", id: "cl-der-sur" }, "Dernière course")),
        h("h2", { class: "cl-der-nom", id: "cl-der-titre" }, "Pas encore de course"),
        h("p", { class: "cl-gp-ligne" }, "Le résultat du premier Grand Prix apparaîtra ici."));
      return;
    }
    const res = course.resultats;
    const podium = res.filter((r) => r.statut === "fini" && r.pos >= 1 && r.pos <= 3).sort((a, b) => a.pos - b.pos);
    const surPodium = new Set(podium.map((r) => r.pilote));
    const actifs = calc.joueursActifs;
    const nbPilotesPodium = podium.filter((r) => joueurActif(r.pilote)).length;
    let puce = null;
    if (nbPilotesPodium) {
      puce = nbPilotesPodium === 1 ? "Un pilote sur le podium"
        : nbPilotesPodium === actifs.length ? `Les ${nbPilotesPodium} pilotes sur le podium` : `${nbPilotesPodium} pilotes sur le podium`;
    }
    const points = (r) => { const p = C.pointsDe(r, saison.bareme); return p ? `+${p}` : "0"; };
    const autres = actifs.filter((p) => !surPodium.has(p.id)).map((p) => ({ p, r: res.find((x) => x.pilote === p.id) }));
    remplir(zone,
      h("div", { class: "cl-haut" }, h("span", { class: "sur", id: "cl-der-sur" }, "Dernière course"), h("span", { class: "cl-note n" }, course.manche != null ? `Manche ${course.manche}` : "Hors calendrier")),
      h("h2", { class: "cl-der-nom", id: "cl-der-titre" }, course.nomGp),
      podium.length ? h("ol", { class: "cl-podium", "aria-label": "Podium" }, podium.map((r) => h("li", {},
        h("span", { class: `cl-medaille m${r.pos}` }, String(r.pos)),
        h("span", { class: "cl-qui" }, h("b", {}, nomAvecPastille(r)), h("small", {}, C.nomEcurie(r.ecurie))),
        h("span", { class: "cl-points n" }, points(r))))) : h("p", { class: "cl-gp-ligne" }, "Aucun classé dans cette course."),
      puce ? h("p", { class: "cl-der-pied" }, h("span", { class: "puce puce-or" }, puce)) : null,
      autres.length ? h("ul", { class: "cl-autres", "aria-label": "Les autres pilotes" }, autres.map(({ p, r }) => h("li", {},
        h("span", { class: "cl-nm" }, pastille(p.joueur), p.nom),
        h("span", { class: "cl-autre-res n" }, r ? `${libelleResultat(r)}${r.statut === "absent" ? "" : ` · ${points(r)}`}` : "Pas au départ")))) : null);
  }

  // Classement : un seul constructeur de tableau pour l'accueil (compact) et la page (complet)

  function lignesCompactes(liste) {
    const sortie = [];
    liste.slice(0, 10).forEach((p) => sortie.push({ p }));
    let trou = [];
    liste.slice(10).forEach((p) => {
      if (!p.joueur) { trou.push(p); return; }
      if (trou.length) sortie.push({ trou });
      trou = [];
      sortie.push({ p });
    });
    return sortie;
  }

  function libelleTrou(trou) {
    const a = trou[0].rang, b = trou[trou.length - 1].rang;
    if (trou.length === 1) return `${ordinal(a)} : 1 autre pilote`;
    return `${trou.length === 2 ? `${ordinal(a)} et ${ordinal(b)}` : `${ordinal(a)} à ${ordinal(b)}`} : ${trou.length} autres pilotes`;
  }

  const compteur = (n) => h("td", { class: `cl-d cl-col-vp n${n ? "" : " cl-zero"}` }, String(n));

  function tableClassement(compact) {
    const { calc } = etat;
    const [leader] = calc.classementPilotes;
    const nous = etat.filtres.pilotes === "nous";
    const liste = nous ? calc.classementPilotes.filter((p) => p.joueur) : calc.classementPilotes;
    const courses = compact ? calc.courses.slice(-NB_COURSES_ACCUEIL) : calc.courses;
    const colonnes = 5 + (compact ? 0 : 2) + courses.length;
    const lignes = compact && !nous ? lignesCompactes(liste) : liste.map((p) => ({ p }));
    const ligne = ({ p, trou }) => {
      if (trou) return h("tr", { class: "cl-sep" }, h("td", { colspan: colonnes }, libelleTrou(trou)));
      return h("tr", { class: p.joueur ? "cl-joueur" : null, style: p.joueur ? { "--c": couleurJoueur(p.joueur) } : null },
        h("td", { class: "cl-rg n" }, String(p.rang)),
        h("td", { class: "cl-pilote" }, h("span", { class: "cl-nm" }, pastille(p.joueur), p.nom)),
        h("td", { class: "cl-col-ecurie" }, h("span", { class: "cl-eq" }, h("i", { style: { background: C.couleurEcurie(p.ecurie) } }), C.nomEcurie(p.ecurie))),
        h("td", { class: "cl-d cl-pts n" }, String(p.points)),
        h("td", { class: "cl-d cl-ecart n" }, ecartTexte(p.points - leader.points)),
        compact ? null : [compteur(p.stats.victoires), compteur(p.stats.podiums)],
        courses.map((c) => h("td", { class: "cl-c" }, caseResultat(p.resultats[c.index], c))));
    };
    return h("table", { class: compact ? "cl-t-accueil" : "cl-t-pilotes" },
      h("caption", { class: "sr-seulement" }, `Classement pilotes${nous ? " : nous seulement" : ""}, après ${calc.courses.length} GP`),
      h("thead", {}, h("tr", {},
        h("th", { class: "cl-rg", scope: "col" }, compact ? [h("span", { class: "cl-lg" }, "Rang"), h("abbr", { class: "cl-sm", title: "Rang" }, "N°")] : "Rang"),
        h("th", { class: "cl-pilote", scope: "col" }, "Pilote"),
        h("th", { class: "cl-col-ecurie", scope: "col" }, "Écurie"),
        h("th", { class: "cl-d", scope: "col" }, "Pts"),
        h("th", { class: "cl-d cl-ecart", scope: "col" }, "Écart"),
        compact ? null : [h("th", { class: "cl-d cl-col-vp", scope: "col" }, h("abbr", { title: "Victoires" }, "Vict.")),
          h("th", { class: "cl-d cl-col-vp", scope: "col" }, h("abbr", { title: "Podiums" }, "Pod."))],
        courses.map((c) => h("th", { class: "cl-c", scope: "col", title: c.nomGp }, c.code)))),
      h("tbody", {}, lignes.map(ligne)));
  }

  function basculePilotes() {
    const bouton = (valeur, texte) => h("button", { type: "button", "data-valeur": valeur, "aria-pressed": etat.filtres.pilotes === valeur ? "true" : "false" }, texte);
    return h("div", { class: "bascule", "data-filtre": "pilotes", role: "group", "aria-label": "Pilotes affichés" }, bouton("tous", "Toute la grille"), bouton("nous", "Nous seulement"));
  }

  function rendreTableAccueil() {
    const corps = $("cl-tab-corps");
    if (!corps) return;
    const { calc } = etat;
    if (!calc.courses.length) {
      remplir(corps, h("p", { class: "cl-gp-ligne cl-corps-vide" }, "Le classement apparaîtra après le premier Grand Prix."));
      return;
    }
    remplir(corps, 
      h("div", { class: "cl-defile" }, tableClassement(true)),
      h("div", { class: "cl-tab-pied" }, legendeCases(),
        h("a", { class: "lien-fl", href: "#/classement/pilotes" }, `Voir les ${calc.classementPilotes.length} pilotes`, icone("i-fleche"))));
  }

  function construireTableAccueil() {
    remplir($("cl-tab"),
      h("div", { class: "cl-tab-tete" }, h("h2", { id: "cl-tab-titre" }, "Classement pilotes"), basculePilotes()),
      h("div", { id: "cl-tab-corps" }));
    rendreTableAccueil();
  }

  function rendreMesCartes() {
    const zone = $("cl-mes");
    const c = etat.cartes;
    const entete = (lien) => h("div", { class: "cl-haut" }, h("span", { class: "sur", id: "cl-mes-titre" }, "Mes cartes"),
      lien ? h("a", { class: "lien-fl", href: "#/cartes/boosters" }, "Boosters", icone("i-chevron")) : null);
    arreterMinuterie();
    if (!c) {
      remplir(zone, entete(false), h("p", { class: "cl-gp-ligne" }, etat.cartesTardives ? "Les cartes sont indisponibles pour le moment." : "Chargement…"));
      return;
    }
    const moi = c.moi;
    if (!moi) {
      const inconnu = !!c.session;
      remplir(zone, entete(false),
        h("p", { class: "cl-gp-ligne" }, inconnu ? "Ce compte n'est pas reconnu par le serveur des cartes." : c.panne ? "Le serveur des cartes est injoignable." : "Connectez-vous pour ouvrir vos boosters."),
        inconnu || c.panne ? h("a", { class: "btn btn-s btn-plein", href: "#/cartes" }, "Voir les cartes")
          : h("button", { type: "button", class: "btn btn-p btn-plein", id: "cl-mes-connexion", onclick: () => { if (window.CartesApp) window.CartesApp.ouvrirConnexion(); } }, "Se connecter"),
        h("a", { class: "cl-lien-ligne", href: "#/cartes/collections" }, h("span", {}, "Collections des joueurs"), icone("i-chevron")));
      return;
    }
    const o = moi.offerts && moi.offerts.intervalle > 0 ? moi.offerts : null;
    const pret = moi.boostersDispo;
    const offerts = o ? h("div", { class: "cl-offerts" },
      h("div", { class: "cl-offerts-l" }, h("span", {}, "Boosters offerts"), h("b", { class: "n" }, `${o.stock} / ${o.max}`)),
      h("div", { class: "cl-barre", role: "img", "aria-label": `${pluriel(o.stock, "booster")} offert${o.stock > 1 ? "s" : ""} sur ${o.max}` },
        h("i", { style: { width: `${o.max ? Math.min(100, (100 * o.stock) / o.max) : 0}%` } })),
      o.stock >= o.max ? h("p", { class: "cl-chrono" }, icone("i-horloge"), h("span", {}, "Stock plein"))
        : o.fin ? h("p", { class: "cl-chrono" }, icone("i-horloge"), h("span", { id: "cl-chrono-texte" })) : null) : null;
    remplir(zone,
      entete(true),
      h("div", { class: "cl-mes-gros n" }, String(pret), " ", h("small", {}, pret > 1 ? "boosters à ouvrir" : "booster à ouvrir")),
      offerts,
      pret > 0 ? h("a", { class: "btn btn-p btn-plein", href: "#/cartes/boosters" }, "Ouvrir un booster")
        : h("a", { class: "btn btn-s btn-plein", href: "#/cartes/boosters" }, "Voir les boosters"),
      h("a", { class: "cl-lien-ligne", href: "#/cartes/collection" }, h("span", {}, "Ma collection"),
        h("span", { class: "n" }, `${moi.nbCartes} / ${c.totalCartes}`), icone("i-chevron")));
    if (!$("accueil").hidden) demarrerMinuterie();
  }

  function rendreAvenir() {
    const { saison, calc } = etat;
    const zone = $("cl-avenir");
    const m = calc.prochaine;
    const faits = new Set(calc.courses.map((c) => c.manche).filter((x) => x != null));
    const suivants = m ? saison.calendrier.filter((x) => x.manche > m.manche && !faits.has(x.manche)).slice(0, 6) : [];
    zone.hidden = !suivants.length;
    if (!suivants.length) return;
    remplir(zone,
      h("span", { class: "sur", id: "cl-av-titre" }, `Après ${m.gp}`),
      h("ol", { class: "cl-liste-av" }, suivants.map((x) => h("li", {}, h("a", { href: "#/courses" }, h("span", { class: "cl-m n" }, String(x.manche)), x.gp)))),
      h("a", { class: "lien-fl cl-bas", href: "#/courses" }, "Voir le calendrier", icone("i-fleche")));
  }

  // Compte à rebours du prochain booster offert : un seul minuteur, arrêté dès que la carte ou la page disparaît

  function majChrono() {
    const zone = $("cl-chrono-texte");
    const o = etat.cartes && etat.cartes.moi && etat.cartes.moi.offerts;
    if (!zone || !o || !o.fin || $("accueil").hidden) { arreterMinuterie(); return; }
    const reste = Math.max(0, (o.fin - Date.now()) / 1000);
    zone.replaceChildren(...(reste > 0 ? ["Prochain dans ", h("b", { class: "n" }, dureeCourte(reste))] : ["Un nouveau booster arrive…"]));
  }
  function demarrerMinuterie() {
    arreterMinuterie();
    if (!$("cl-chrono-texte")) return;
    majChrono();
    etat.minuterie = setInterval(majChrono, 1000);
  }
  function arreterMinuterie() {
    if (etat.minuterie) clearInterval(etat.minuterie);
    etat.minuterie = null;
  }

  // Signatures : les cartes qui dépendent du jeu de cartes ne sont reconstruites que si ce qu'elles montrent change
  // (un rafraîchissement toutes les 45 s ne doit pas faire perdre le focus à qui navigue au clavier).
  function signatureCartes() {
    const c = etat.cartes, m = c && c.moi;
    return JSON.stringify([c && [c.panne, c.chargee, !!c.session, c.totalCartes],
      m && [m.id, m.boostersDispo, m.nbCartes, m.offerts && [m.offerts.stock, m.offerts.max, m.offerts.intervalle, m.offerts.fin === null]],
      etat.cartesTardives, etatPronos(), etat.saison && etat.saison.maj]);
  }

  // Le tableau de bord se construit à l'arrivée des données : cinq zones, remplies ensuite carte par carte
  function construireSquelette() {
    const zone = $("accueil-contenu");
    if (zone.querySelector(".cl-accueil")) return;
    remplir(zone, h("div", { class: "cl-accueil" },
      h("section", { class: "cl-kpis", id: "cl-kpis", "aria-labelledby": "cl-kpis-titre" },
        h("h2", { class: "cl-kpis-titre", id: "cl-kpis-titre" }, "Les pilotes"), h("div", { class: "cl-kpis-liste", id: "cl-kpis-liste" })),
      h("section", { class: "bloc cl-gp", id: "cl-gp", "aria-labelledby": "cl-gp-sur cl-gp-titre" }),
      h("section", { class: "bloc cl-der", id: "cl-der", "aria-labelledby": "cl-der-sur cl-der-titre" }),
      h("section", { class: "bloc cl-tab cl-tab-accueil", id: "cl-tab", "aria-labelledby": "cl-tab-titre" }),
      h("div", { class: "cl-colonne" },
        h("section", { class: "bloc cl-mes", id: "cl-mes", "aria-labelledby": "cl-mes-titre" }),
        h("section", { class: "bloc cl-avenir", id: "cl-avenir", "aria-labelledby": "cl-av-titre" }))));
  }

  function rendreAccueil(source) {
    if (!etat.calc) return;
    construireSquelette();
    if (source === "donnees") {
      rendreDerniere();
      rendreAvenir();
      construireTableAccueil();
    }
    const signature = signatureCartes();
    if (source === "donnees" || signature !== etat.signatureAccueil) {
      etat.signatureAccueil = signature;
      rendreKpis();
      rendreGp();
      rendreMesCartes();
    }
  }

  // --- Classement : pilotes ---------------------------------------------------------

  function rendrePilotes() {
    const { calc } = etat;
    const zone = vider("table-pilotes");
    if (!calc.courses.length) {
      zone.appendChild(vide("Le classement apparaîtra après le premier Grand Prix."));
      return;
    }
    zone.appendChild(h("section", { class: "bloc cl-tab cl-pg", "aria-label": "Classement pilotes" },
      h("div", { class: "cl-defile" }, tableClassement(false)),
      h("div", { class: "cl-tab-pied" }, legendeCases())));
  }

  // --- Classement : constructeurs ---------------------------------------------------

  function rendreEcuries() {
    const { calc } = etat;
    const zone = vider("table-ecuries");
    if (!calc.courses.length) {
      zone.appendChild(vide("Le classement constructeurs apparaîtra après le premier Grand Prix."));
      return;
    }
    const [leader] = calc.classementEcuries;
    const ligne = (e) => {
      const pilotes = [...e.pilotes];
      const nous = pilotes.find((p) => p.joueur);
      return h("tr", { class: nous ? "cl-equipe" : null },
        h("td", { class: "cl-rg n" }, String(e.rang)),
        h("td", { class: "cl-pilote" },
          h("span", { class: "cl-eq cl-eq-nom" }, h("i", { style: { background: e.couleur } }), e.nom),
          h("span", { class: "cl-equipiers-m" }, pilotes.map((p, i) => [i ? " · " : null, p.joueur ? h("b", {}, p.nom) : p.nom]))),
        h("td", { class: "cl-col-pilotes" }, h("span", { class: "cl-equipiers" }, pilotes.map((p) => h("span", { class: "cl-nm" }, pastille(p.joueur), p.nom)))),
        h("td", { class: "cl-d cl-pts n" }, String(e.points)),
        h("td", { class: "cl-d cl-ecart n" }, ecartTexte(e.points - leader.points)),
        compteur(e.decompte[1]),
        compteur(e.decompte[1] + e.decompte[2] + e.decompte[3]),
        calc.courses.map((c, k) => h("td", { class: "cl-c n" },
          e.resultats[k] === null ? h("span", { class: "cl-pc cl-zero", title: `${c.nomGp} : pas au départ` }, "–")
            : h("span", { class: e.resultats[k] > 0 ? "cl-pc" : "cl-pc cl-zero", title: `${c.nomGp} : ${pts(e.resultats[k])}` }, String(e.resultats[k])))));
    };
    zone.appendChild(h("section", { class: "bloc cl-tab cl-pg", "aria-label": "Classement constructeurs" },
      h("div", { class: "cl-defile" }, h("table", { class: "cl-t-ecuries" },
        h("caption", { class: "sr-seulement" }, `Classement constructeurs, après ${calc.courses.length} GP`),
        h("thead", {}, h("tr", {},
          h("th", { class: "cl-rg", scope: "col" }, "Rang"),
          h("th", { class: "cl-pilote", scope: "col" }, "Écurie"),
          h("th", { class: "cl-col-pilotes", scope: "col" }, "Pilotes"),
          h("th", { class: "cl-d", scope: "col" }, "Pts"),
          h("th", { class: "cl-d cl-ecart", scope: "col" }, "Écart"),
          h("th", { class: "cl-d cl-col-vp", scope: "col" }, h("abbr", { title: "Victoires" }, "Vict.")),
          h("th", { class: "cl-d cl-col-vp", scope: "col" }, h("abbr", { title: "Podiums" }, "Pod.")),
          calc.courses.map((c) => h("th", { class: "cl-c", scope: "col", title: c.nomGp }, c.code)))),
        h("tbody", {}, calc.classementEcuries.map(ligne)))),
      h("div", { class: "cl-tab-pied" }, h("p", { class: "cl-note-pied" }, "Points de l'écurie à chaque course."))));
  }

  // --- Évolution (graphique) ------------------------------------------------------------

  function echelleRonde(max) {
    if (max <= 0) return { max: 10, pas: 5 };
    const brut = max / 5;
    const puissance = Math.pow(10, Math.floor(Math.log10(brut)));
    const pas = [1, 2, 2.5, 5, 10].map((m) => m * puissance).find((p) => p >= brut);
    return { max: Math.ceil(max / pas) * pas, pas };
  }

  function rendreEvolution() {
    const { calc } = etat;
    const n = calc.courses.length;
    const modeRang = etat.filtres.evolution === "rang";
    $("evolution-carte").hidden = !n;
    $("evolution-vide").hidden = !!n;
    const titre = $("graphique-titre");
    titre.textContent = modeRang ? "Position au classement général après chaque GP" : "Points cumulés après chaque GP";
    const zone = vider("graphique");
    const legende = vider("legende");
    const tableau = vider("evolution-table");
    if (!n) return;

    const series = calc.joueursActifs.map((p) => ({
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
    const texteValeur = (v) => (v == null ? "–" : modeRang ? `P${v}` : String(v));

    for (const se of series) {
      legende.appendChild(h("span", {}, h("i", { class: "cl-cle", style: { background: se.couleur } }),
        se.reference ? "Leader du championnat (toute la grille)" : se.nom));
    }
    tableau.appendChild(h("table", {},
      h("caption", { class: "sr-seulement" }, titre.textContent),
      h("thead", {}, h("tr", {}, h("th", { scope: "col" }, "Grand Prix"), series.map((se) => h("th", { class: "cl-d", scope: "col" }, se.reference ? "Leader" : se.nom)))),
      h("tbody", {}, calc.courses.map((c, i) => h("tr", {}, h("td", {}, `${c.manche ? `${c.manche}. ` : ""}${c.nomGp}`),
        series.map((se) => h("td", { class: "cl-d n" }, texteValeur(se.valeurs[i]))))))));

    if ($("evolution").hidden) return;   // le graphique se mesure à l'écran : il est dessiné quand sa page devient visible
    const largeur = Math.max(zone.clientWidth, 280);
    const mobile = largeur < 560;
    const hauteur = mobile ? 260 : 320;
    const m = { haut: 12, droite: mobile ? 96 : 120, bas: 28, gauche: 34 };
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

    const finaux = series.filter((se) => !se.reference).map((se) => {
      const v = se.valeurs.filter((x2) => x2 != null);
      return `${se.nom} ${texteValeur(v[v.length - 1])}`;
    });
    const svg = s("svg", { viewBox: `0 0 ${largeur} ${hauteur}`, role: "img", tabindex: "0",
      "aria-label": `${titre.textContent}. Après ${n} GP : ${finaux.join(", ")}. Flèches gauche et droite pour parcourir les courses.` });

    for (const t of ticks) {
      svg.appendChild(s("line", { x1: m.gauche, x2: m.gauche + lp, y1: y(t), y2: y(t), class: "cl-grille" }));
      svg.appendChild(s("text", { x: m.gauche - 8, y: y(t) + 4, "text-anchor": "end", class: "cl-axe" }, modeRang ? `P${t}` : String(t)));
    }
    const pasEtiquettes = Math.max(1, Math.ceil((n * 34) / lp));
    calc.courses.forEach((c, i) => {
      if (i % pasEtiquettes !== 0 && i !== n - 1) return;
      svg.appendChild(s("text", { x: x(i), y: hauteur - 8, "text-anchor": "middle", class: "cl-axe" }, c.code));
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
        svg.appendChild(s("path", { d, fill: "none", stroke: se.couleur, "stroke-width": se.reference ? 1.5 : 2.5,
          "stroke-linejoin": "round", "stroke-linecap": "round", "stroke-dasharray": se.reference ? "4 4" : null }));
      }
      const iFin = se.valeurs.map((v) => v != null).lastIndexOf(true);
      if (iFin >= 0) {
        svg.appendChild(s("circle", { cx: x(iFin), cy: y(se.valeurs[iFin]), r: se.reference ? 3 : 4.5,
          fill: se.couleur, class: "cl-point" }));
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
      const court = nom.length > (mobile ? 12 : 16) ? `${nom.slice(0, mobile ? 11 : 15)}…` : nom;
      const valeur = modeRang ? `P${e.se.valeurs[e.iFin]}` : pts(e.se.valeurs[e.iFin]);
      if (Math.abs(e.yTexte - e.yLigne) > 2 || x(e.iFin) < m.gauche + lp - 1) {
        svg.appendChild(s("path", { d: `M${x(e.iFin) + 6},${e.yLigne} L${xTexte - 4},${e.yTexte}`, class: "cl-rappel", fill: "none" }));
      }
      svg.appendChild(s("text", { x: xTexte, y: e.yTexte - 1, class: "cl-etiquette" }, court));
      svg.appendChild(s("text", { x: xTexte, y: e.yTexte + 12, class: "cl-etiquette-val" }, valeur));
    }

    // Survol : réticule vertical + infobulle avec toutes les séries
    const reticule = s("line", { y1: m.haut, y2: m.haut + hp, class: "cl-reticule", visibility: "hidden" });
    const points = s("g", { visibility: "hidden" });
    svg.appendChild(reticule);
    svg.appendChild(points);
    const zoneSurvol = s("rect", { x: m.gauche - 10, y: m.haut, width: lp + 20, height: hp, fill: "transparent" });
    svg.appendChild(zoneSurvol);
    const bulle = $("infobulle");

    function montrer(i, cx, cy) {
      reticule.setAttribute("x1", x(i)); reticule.setAttribute("x2", x(i));
      reticule.setAttribute("visibility", "visible");
      points.replaceChildren();
      for (const se of series) {
        const v = se.valeurs[i];
        if (v == null) continue;
        points.appendChild(s("circle", { cx: x(i), cy: y(v), r: 4.5, fill: se.couleur, class: "cl-point" }));
      }
      points.setAttribute("visibility", "visible");
      const c = calc.courses[i];
      const lignes = series.filter((se) => se.valeurs[i] != null)
        .sort((a, b) => (modeRang ? a.valeurs[i] - b.valeurs[i] : b.valeurs[i] - a.valeurs[i]));
      remplir(bulle, 
        h("div", { class: "cl-bulle-titre" }, `${c.manche ? `Manche ${c.manche} · ` : ""}${c.nomGp}`),
        lignes.map((se) => h("div", { class: "cl-bulle-ligne" },
          h("i", { class: "cl-cle", style: { background: se.couleur } }),
          h("strong", { class: "n" }, modeRang ? `P${se.valeurs[i]}` : String(se.valeurs[i])),
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

  // --- Duels ------------------------------------------------------------------------------

  function rendreDuels() {
    const { calc } = etat;
    const liste = vider("liste-duels");
    const matrice = vider("matrice-duels");
    const joueurs = calc.joueursActifs;
    if (!calc.courses.length) {
      liste.appendChild(vide("Les duels apparaîtront après le premier Grand Prix."));
      return;
    }
    if (joueurs.length < 2) {
      liste.appendChild(vide("Il faut au moins deux pilotes pour un duel."));
      return;
    }
    for (let i = 0; i < joueurs.length; i++) {
      for (let k = i + 1; k < joueurs.length; k++) {
        const a = joueurs[i], b = joueurs[k];
        const da = calc.duels[a.id][b.id], db = calc.duels[b.id][a.id];
        const ecart = a.points - b.points;
        liste.appendChild(h("article", { class: "bloc cl-duel" },
          h("div", { class: "cl-duel-ligne" },
            h("span", { class: "cl-duel-nom" }, pastille(a.joueur), h("span", {}, a.nom)),
            h("span", { class: "cl-duel-score n" },
              h("span", { class: da.devant > db.devant ? "cl-haut-score" : null }, String(da.devant)), " – ",
              h("span", { class: db.devant > da.devant ? "cl-haut-score" : null }, String(db.devant))),
            h("span", { class: "cl-duel-nom cl-duel-nom-droite" }, h("span", {}, b.nom), pastille(b.joueur))),
          h("div", { class: "cl-duel-barre", "aria-hidden": "true" },
            da.total === 0 ? h("span", { class: "neutre" }) : [
              da.devant ? h("span", { style: { flex: String(da.devant), background: couleurJoueur(a.joueur) } }) : null,
              db.devant ? h("span", { style: { flex: String(db.devant), background: couleurJoueur(b.joueur) } }) : null,
            ]),
          h("p", { class: "cl-duel-detail n" },
            da.total === 0 ? "Pas encore de course ensemble" : `${pluriel(da.total, "course")} ensemble`,
            " · ",
            ecart === 0 ? "égalité de points" : `${ecart > 0 ? a.nom : b.nom} devant de ${pts(Math.abs(ecart))}`)));
      }
    }
    matrice.appendChild(h("section", { class: "bloc cl-matrice", "aria-labelledby": "cl-matrice-titre" },
      h("h3", { id: "cl-matrice-titre" }, "Tableau des face-à-face"),
      h("div", { class: "cl-defile" }, h("table", {},
        h("caption", { class: "sr-seulement" }, "Nombre de courses où le pilote de la ligne a fini devant celui de la colonne"),
        h("thead", {}, h("tr", {}, h("th", { scope: "col" }, "Devant ↓ / derrière →"),
          joueurs.map((b) => h("th", { class: "cl-c", scope: "col" }, b.nom)))),
        h("tbody", {}, joueurs.map((a) => h("tr", {},
          h("td", {}, h("span", { class: "cl-nm" }, pastille(a.joueur), a.nom)),
          joueurs.map((b) => {
            if (a.id === b.id) return h("td", { class: "cl-c cl-zero" }, "·");
            const d = calc.duels[a.id][b.id];
            return h("td", { class: "cl-c n", title: `${a.nom} a fini devant ${b.nom} ${d.devant} fois sur ${d.total}` }, d.total ? `${d.devant} / ${d.total}` : "—");
          }),
        )))))));
  }

  // --- Stats ---------------------------------------------------------------------------------

  function rendreStats() {
    const { calc } = etat;
    const zone = vider("table-stats");
    if (!calc.courses.length) {
      zone.appendChild(vide("Les stats apparaîtront après le premier Grand Prix."));
      return;
    }
    const nous = etat.filtres.stats === "nous";
    const liste = nous ? calc.joueursActifs.slice().sort((a, b) => (a.rang || 99) - (b.rang || 99)) : calc.classementPilotes;
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
    zone.appendChild(h("section", { class: "bloc cl-tab cl-pg", "aria-label": "Stats pilotes" },
      h("div", { class: "cl-defile" }, h("table", { class: "cl-t-stats" },
        h("caption", { class: "sr-seulement" }, `Stats des pilotes${nous ? " : nous seulement" : ""}, après ${calc.courses.length} GP`),
        h("thead", {}, h("tr", {}, h("th", { class: "cl-rg", scope: "col" }, "Rang"), h("th", { class: "cl-pilote", scope: "col" }, "Pilote"),
          colonnes.map(([nom]) => h("th", { class: "cl-d", scope: "col" }, nom)))),
        h("tbody", {}, liste.map((p) => h("tr", { class: p.joueur ? "cl-joueur" : null, style: p.joueur ? { "--c": couleurJoueur(p.joueur) } : null },
          h("td", { class: "cl-rg n" }, p.rang ? String(p.rang) : "–"),
          h("td", { class: "cl-pilote" }, h("span", { class: "cl-nm" }, pastille(p.joueur), p.nom)),
          colonnes.map(([, f]) => h("td", { class: "cl-d n" }, String(f(p.stats)))))))))));
  }

  // --- Courses ----------------------------------------------------------------------------------

  function heroCourses() {
    const { saison, calc } = etat;
    const n = calc.courses.length, total = saison.calendrier.length, m = calc.prochaine;
    if (!m && !n) return vide("Le calendrier de la saison n'est pas encore défini.");
    const barre = barreSaison();
    if (m) {
      const pr = etatPronos();
      return h("section", { class: "bloc cl-hero", "aria-labelledby": "cl-hero-titre" },
        h("div", { class: "cl-hero-g" },
          h("div", { class: "sur rouge" }, `${n ? "Prochain" : "Premier"} Grand Prix · Manche ${m.manche} / ${total}`),
          h("h2", { class: "cl-gp-nom", id: "cl-hero-titre" }, m.gp),
          pr ? h("div", { class: "cl-gp-etat" }, puceEtatPronos(pr), pr.ouvert ? h("span", { class: "n" }, `${pr.k} / ${pr.n} ont parié`) : null) : null),
        h("div", { class: "cl-hero-d" }, barre, pr ? h("div", {}, actionsGp(pr, false)) : null));
    }
    const [premier] = calc.classementPilotes;
    return h("section", { class: "bloc cl-hero", "aria-labelledby": "cl-hero-titre" },
      h("div", { class: "cl-hero-g" },
        h("div", { class: "sur rouge" }, "Saison terminée"),
        h("h2", { class: "cl-gp-nom", id: "cl-hero-titre" }, premier ? `Champion : ${premier.nom}` : "Saison terminée"),
        premier ? h("div", { class: "cl-gp-etat" }, h("span", { class: "n" }, pts(premier.points))) : null),
      h("div", { class: "cl-hero-d" }, barre, h("div", {}, h("a", { class: "btn btn-p", href: "#/classement" }, "Voir le classement"))));
  }

  function carteCourse(course, manche, nom) {
    const res = course.resultats;
    const de = (pos) => res.find((r) => r.statut === "fini" && r.pos === pos);
    const gagnant = de(1), p2 = de(2), p3 = de(3);
    const gras = (r) => (joueurActif(r.pilote) ? h("b", {}, nomResultat(r)) : nomResultat(r));
    const meilleur = res.filter((r) => joueurActif(r.pilote) && r.statut === "fini").sort((a, b) => a.pos - b.pos)[0];
    return h("li", { class: "cl-gpt" },
      h("div", { class: "cl-gpt-h" }, h("span", { class: "sur n" }, manche != null ? `Manche ${manche}` : "Hors calendrier"), h("span", { class: "puce cl-puce-fait" }, "Couru")),
      h("h3", {}, nom),
      gagnant ? h("p", { class: "cl-vq" }, h("span", { class: "cl-vq-l" }, "Vainqueur"), nomAvecPastille(gagnant)) : null,
      p2 || p3 ? h("p", { class: "cl-dp n" }, p2 ? ["2 ", gras(p2)] : null, p2 && p3 ? " · " : null, p3 ? ["3 ", gras(p3)] : null) : null,
      meilleur && meilleur.pos > 3 ? h("p", { class: "cl-dp n" }, "Meilleur d'entre nous : ", h("b", {}, nomResultat(meilleur)), ` (P${meilleur.pos})`) : null);
  }

  function rendreCourses() {
    const { saison, calc } = etat;
    const hero = vider("courses-hero");
    const liste = vider("liste-calendrier");
    hero.appendChild(heroCourses());
    const pr = etatPronos();
    for (const m of saison.calendrier) {
      const course = calc.courses.find((c) => c.manche === m.manche);
      if (course) { liste.appendChild(carteCourse(course, m.manche, m.gp)); continue; }
      if (calc.prochaine && calc.prochaine.manche === m.manche) {
        liste.appendChild(h("li", { class: "cl-gpt cl-prochain", "aria-current": "step" },
          h("div", { class: "cl-gpt-h" }, h("span", { class: "sur rouge n" }, `Manche ${m.manche}`), h("span", { class: "puce cl-puce-prochain" }, "Prochain GP")),
          h("h3", {}, m.gp),
          pr ? [h("p", { class: "cl-pr" }, pr.ouvert ? "Pronostics ouverts" : "Pronostics fermés"), pr.ouvert ? h("p", { class: "cl-pr n" }, `${pr.k} / ${pr.n} ont parié`) : null] : null));
        continue;
      }
      liste.appendChild(h("li", { class: "cl-gpt cl-futur" }, h("div", { class: "cl-gpt-h" }, h("span", { class: "sur n" }, `Manche ${m.manche}`)), h("h3", {}, m.gp)));
    }
    // Courses sans manche, ou dont la manche n'est pas au calendrier
    const auCalendrier = new Set(saison.calendrier.map((m) => m.manche));
    for (const course of calc.courses.filter((c) => c.manche == null || !auCalendrier.has(c.manche))) liste.appendChild(carteCourse(course, null, course.nomGp));
    liste.hidden = !liste.children.length;
  }

  function rendrePied() {
    const pied = vider("pied-maj");
    if (etat.saison.maj) {
      const d = new Date(etat.saison.maj);
      pied.appendChild(document.createTextNode(
        `Mis à jour le ${d.toLocaleDateString("fr-FR")} à ${d.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })} · Résultats enregistrés automatiquement par la télémétrie de F1 25`));
    }
  }

  // --- Rendu général, événements, chargement -------------------------------------------------

  // Un écran qui plante ne doit pas vider les autres
  function isoler(fonction) {
    try { fonction(); } catch (e) { console.error(e); }
  }

  function rendre() {
    etat.calc = C.calculer(etat.saison);
    etat.ctx = preparerContexte();
    isoler(majTitres);
    isoler(() => rendreAccueil("donnees"));
    isoler(rendrePilotes);
    isoler(rendreEcuries);
    isoler(rendreEvolution);
    isoler(rendreDuels);
    isoler(rendreStats);
    isoler(rendreCourses);
    isoler(rendrePied);
    document.dispatchEvent(new CustomEvent("champ:donnees", { detail: { saison: etat.saison, calc: etat.calc } }));
  }

  // Les cartes (jeu) arrivent après les résultats : on ne redessine que ce qui en dépend
  document.addEventListener("cartes:etat", (evt) => {
    etat.cartes = evt.detail;
    if (!etat.calc) return;
    isoler(() => rendreAccueil("cartes"));
    const sig = JSON.stringify(etatPronos());
    if (sig !== etat.signatureCourses) { etat.signatureCourses = sig; isoler(rendreCourses); }
  });
  setTimeout(() => {
    if (etat.cartes) return;
    etat.cartesTardives = true;
    if (etat.calc) isoler(() => rendreAccueil("cartes"));
  }, 10000);

  document.addEventListener("site:route", (evt) => {
    const id = evt.detail.id;
    if (id === "evolution" && etat.calc) rendreEvolution();   // le graphique se mesure à l'écran : on le (re)dessine à l'arrivée
    if (id === "accueil") demarrerMinuterie(); else arreterMinuterie();
  });

  // Bascules de filtre (statiques ou créées par l'accueil) : un seul réglage partagé par toutes celles du même nom
  document.addEventListener("click", (evt) => {
    const bouton = evt.target.closest(".bascule[data-filtre] button");
    if (!bouton || !etat.calc) return;
    const cle = bouton.closest(".bascule").dataset.filtre;
    etat.filtres[cle] = bouton.dataset.valeur;
    document.querySelectorAll(`.bascule[data-filtre="${cle}"] button`).forEach((b) => {
      b.setAttribute("aria-pressed", b.dataset.valeur === bouton.dataset.valeur ? "true" : "false");
    });
    if (cle === "pilotes") { isoler(rendreTableAccueil); isoler(rendrePilotes); }
    else if (cle === "stats") isoler(rendreStats);
    else if (cle === "evolution") isoler(rendreEvolution);
  });

  let largeurPrecedente = 0;
  window.addEventListener("resize", () => {
    if (window.innerWidth === largeurPrecedente || !etat.calc) return;
    largeurPrecedente = window.innerWidth;
    rendreEvolution();
  });

  function erreurChargement() {
    const message = "Impossible de charger les résultats.";
    for (const id of ["accueil-contenu", "table-pilotes", "table-ecuries", "liste-duels", "table-stats", "courses-hero"]) vider(id).appendChild(vide(message));
  }

  async function charger() {
    let saison;
    try {
      const reponse = await fetch(`data/saison.json?t=${Date.now()}`, { cache: "no-store" });
      saison = await reponse.json();
    } catch (e) {
      if (!etat.saison) erreurChargement();
      return;
    }
    if (saison.maj && saison.maj === etat.maj) return;
    etat.saison = saison;
    etat.maj = saison.maj || null;
    rendre();
  }

  window.Championnat = { donnees: () => (etat.saison && etat.calc ? { saison: etat.saison, calc: etat.calc } : null) };
  charger();
  // Pendant une soirée de course, la page se met à jour toute seule
  setInterval(() => { if (!document.hidden) charger(); }, 60000);
})();

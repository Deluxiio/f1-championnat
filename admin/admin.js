// Admin locale : état de l'enregistreur, corrections des courses, réglages.
(function () {
  "use strict";

  const C = window.Champ;
  let saison = null;
  let revision = null;
  let edition = null; // { course, nouvelle }

  // --- Utilitaires -----------------------------------------------------------

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
      else if (k === "value") el.value = v;
      else el.setAttribute(k, v === true ? "" : v);
    }
    return ajouter(el, enfants);
  }

  const copie = (o) => JSON.parse(JSON.stringify(o));
  const vider = (id) => { const el = document.getElementById(id); el.replaceChildren(); return el; };
  const option = (valeur, texte, choisie) => h("option", { value: String(valeur), selected: choisie || null }, texte);

  function heure(iso) {
    return iso ? new Date(iso).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "";
  }

  function dateCourte(iso) {
    if (!iso) return "—";
    const d = new Date(iso);
    return `${d.toLocaleDateString("fr-FR")} ${d.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}`;
  }

  async function api(methode, chemin, corps) {
    const r = await fetch(chemin, {
      method: methode,
      headers: corps ? { "Content-Type": "application/json" } : {},
      body: corps ? JSON.stringify(corps) : undefined,
    });
    const donnees = await r.json().catch(() => ({}));
    if (!r.ok) {
      const e = new Error(donnees.erreur || `Erreur ${r.status}`);
      e.statut = r.status;
      e.donnees = donnees;
      throw e;
    }
    return donnees;
  }

  function libelleCourse(c) {
    return `${c.manche ? `Manche ${c.manche} – ` : ""}${C.nomCourse(c, saison)}`;
  }

  // --- Saison ------------------------------------------------------------------

  async function chargerSaison() {
    const d = await api("GET", "/api/saison");
    saison = d.saison;
    revision = d.revision;
    document.getElementById("bandeau-revision").hidden = true;
    document.getElementById("titre").textContent = saison.titre;
    rendreCourses();
    rendreReglages();
  }

  async function sauver(nouvelleSaison, publier, message) {
    try {
      const d = await api("PUT", "/api/saison", { revision, saison: nouvelleSaison, publier, message });
      saison = nouvelleSaison;
      revision = d.revision;
      document.getElementById("titre").textContent = saison.titre;
      rendreCourses();
      rendreReglages();
      rafraichirEtat();
      return true;
    } catch (e) {
      alert(e.message);
      if (e.statut === 409) await chargerSaison();
      return false;
    }
  }

  // --- État de l'enregistreur ------------------------------------------------

  function voyant(classe, texte) {
    return h("span", { class: `voyant ${classe}` }, texte);
  }

  function rendreEtat(e) {
    const zone = vider("etat");
    const humains = vider("humains");
    if (!e) {
      zone.appendChild(h("dt", {}, "Enregistreur"));
      zone.appendChild(h("dd", {}, voyant("erreur", "Arrêté"), " ", h("span", { class: "indice" }, "Relance Lancer.bat pour enregistrer les courses.")));
      return;
    }
    const ligne = (titre, ...contenu) => { zone.appendChild(h("dt", {}, titre)); zone.appendChild(h("dd", {}, contenu)); };

    ligne("Télémétrie", e.ecoute.ok
      ? voyant("ok", `En écoute sur ${e.ecoute.ip}:${e.ecoute.port}`)
      : voyant("erreur", e.ecoute.erreur || "Pas en écoute"));

    if (e.dernierPaquetIlYa === null) {
      ligne("Jeu", voyant("attente", "Aucune donnée reçue pour l'instant"), " ",
        h("span", { class: "indice" }, "Dans F1 25 : télémétrie UDP activée, IP 127.0.0.1, port 20777, format 2025."));
    } else if (e.dernierPaquetIlYa < 5) {
      ligne("Jeu", voyant("ok", "Données reçues"), " ", h("span", { class: "indice" }, `${e.paquets.toLocaleString("fr-FR")} paquets`));
    } else {
      ligne("Jeu", voyant("neutre", `Plus de données depuis ${Math.round(e.dernierPaquetIlYa)} s`), " ",
        h("span", { class: "indice" }, "Normal dans les menus du jeu."));
    }

    const s = e.seance;
    if (s) {
      const morceaux = [`${s.type} – ${s.circuit}`, s.enLigne ? "en ligne" : "hors ligne"];
      if (s.tour) morceaux.push(`tour ${s.tour}/${s.toursTotal}`);
      morceaux.push(`${s.nbVoitures} voitures`);
      let suite;
      if (!s.estCourse) suite = voyant("neutre", "Seules les courses sont enregistrées");
      else if (s.classee) suite = voyant("ok", "Classement final reçu");
      else if (!s.enLigne && e.seulementEnLigne) suite = voyant("attente", "Course hors ligne : ne sera pas enregistrée");
      else suite = voyant("ok", "Le résultat sera enregistré à l'arrivée");
      ligne("Séance", morceaux.join(" · "), " ", suite);

      for (const hu of s.humains) {
        if (hu.joueur) {
          humains.appendChild(h("span", { class: "humain" }, voyant("ok", hu.nom), `→ ${hu.joueur}`));
        } else {
          const choix = h("select", { onchange: (evt) => associer(hu.nom, evt.target.value) },
            option("", "Associer à…", true), saison ? saison.joueurs.map((j) => option(j.id, j.nom)) : []);
          humains.appendChild(h("span", { class: "humain" }, voyant("attente", hu.nom), "non reconnu", choix));
        }
      }
    }

    const pub = vider("publication");
    const classes = { ok: "ok", en_cours: "attente", erreur: "erreur", inactif: "neutre" };
    pub.appendChild(h("div", {}, h("strong", {}, "Publication : "),
      voyant(classes[e.publication.etat] || "neutre", e.publication.message || "Rien publié depuis le lancement"),
      e.publication.date ? h("span", { class: "indice" }, ` (${heure(e.publication.date)})`) : null));
    if (e.publicationAuto) pub.appendChild(h("div", { class: "indice" }, "Publication automatique après chaque course enregistrée."));

    const lien = document.getElementById("lien-public");
    if (e.urlPublique) { lien.href = e.urlPublique; lien.hidden = false; }

    const journal = vider("journal");
    for (const l of e.journal) journal.appendChild(h("li", {}, h("time", {}, heure(l.date)), l.msg));
  }

  async function associer(nom, idJoueur) {
    if (!idJoueur) return;
    const nouvelle = copie(saison);
    const j = nouvelle.joueurs.find((x) => x.id === idJoueur);
    j.alias = [...new Set([...(j.alias || []), nom])];
    await sauver(nouvelle, false);
  }

  async function rafraichirEtat() {
    try {
      const e = await api("GET", "/api/etat");
      rendreEtat(e);
      if (revision !== null && e.revision !== revision) {
        if (edition) document.getElementById("bandeau-revision").hidden = false;
        else await chargerSaison();
      }
    } catch (err) {
      rendreEtat(null);
    }
  }

  // --- Liste des courses ---------------------------------------------------

  function rendreCourses() {
    const zone = vider("courses");
    const courses = C.ordreCourses(saison);
    if (!courses.length) {
      zone.appendChild(h("div", { class: "vide" }, "Aucune course enregistrée. Elles apparaîtront ici automatiquement à la fin de chaque course."));
      return;
    }
    const joueurs = new Map(saison.joueurs.map((j) => [`j:${j.id}`, j]));
    const nom = (r) => (joueurs.get(r.pilote) || r).nom;
    zone.appendChild(h("table", {},
      h("thead", {}, h("tr", {}, ["Manche", "Grand Prix", "Date", "Vainqueur", "Meilleur d'entre nous", "Source", "", ""].map((t) => h("th", {}, t)))),
      h("tbody", {}, courses.map((c) => {
        const premier = c.resultats.find((r) => r.pos === 1);
        const nous = c.resultats.filter((r) => r.pilote.startsWith("j:")).sort((a, b) => a.pos - b.pos)[0];
        return h("tr", {},
          h("td", {}, c.manche ? String(c.manche) : "—"),
          h("td", {}, C.nomCourse(c, saison)),
          h("td", {}, dateCourte(c.date)),
          h("td", {}, premier ? nom(premier) : "—"),
          h("td", {}, nous ? `${nom(nous)} (P${nous.pos})` : "—"),
          h("td", {}, c.source === "telemetrie" ? "Télémétrie" : "Manuelle"),
          h("td", {}, c.aVerifier ? h("span", { class: "badge alerte" }, "À vérifier") : ""),
          h("td", {}, h("button", { type: "button", class: "bouton secondaire", onclick: () => ouvrirEditeur(c, false) }, "Modifier")),
        );
      })),
    ));
  }

  // --- Éditeur de course ---------------------------------------------------

  function ouvrirEditeur(course, nouvelle) {
    const c = copie(course);
    c.resultats.sort((a, b) => a.pos - b.pos);
    for (const r of c.resultats) r._original = { pilote: r.pilote, nom: r.nom };
    edition = { course: c, nouvelle };
    rendreEditeur();
    document.getElementById("editeur").scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function fermerEditeur() {
    edition = null;
    const zone = document.getElementById("editeur");
    zone.hidden = true;
    zone.replaceChildren();
    if (!document.getElementById("bandeau-revision").hidden) chargerSaison();
  }

  function nouveauResultat() {
    return { pos: 0, pilote: `manuel:${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, nom: "",
      ecurie: null, numero: null, grille: 0, tours: null, statut: "fini", meilleurTour: null, tempsTotal: null,
      penalites: 0, nbPenalites: 0, arrets: null, pneus: [], _original: { pilote: "", nom: "" } };
  }

  function rendreEditeur() {
    const zone = document.getElementById("editeur");
    zone.hidden = false;
    zone.replaceChildren();
    const c = edition.course;

    zone.appendChild(h("h2", {}, edition.nouvelle ? "Nouvelle course" : `Modifier : ${libelleCourse(c)}`));
    if (c.remarques && c.remarques.length) {
      zone.appendChild(h("ul", { class: "remarques" }, c.remarques.map((r) => h("li", {}, r))));
    }

    zone.appendChild(h("div", { class: "champs" },
      h("label", {}, "Manche",
        h("select", { onchange: (evt) => {
          c.manche = evt.target.value === "" ? null : Number(evt.target.value);
          const m = saison.calendrier.find((x) => x.manche === c.manche);
          if (m && edition.nouvelle) c.circuit = m.circuit;
          rendreEditeur();
        } },
          option("", "Hors calendrier", c.manche == null),
          saison.calendrier.map((m) => option(m.manche, `${m.manche} – ${m.gp}`, m.manche === c.manche)))),
      h("label", {}, "Circuit",
        h("select", { onchange: (evt) => { c.circuit = Number(evt.target.value); } },
          c.circuit == null ? option("", "—", true) : null,
          Object.entries(C.CIRCUITS).map(([id, [nom]]) => option(id, nom, Number(id) === c.circuit)))),
      h("label", {}, "Date",
        h("input", { type: "datetime-local", value: (c.date || "").slice(0, 16),
          onchange: (evt) => { c.date = evt.target.value ? `${evt.target.value}:00` : c.date; } })),
    ));

    const ecuries = Object.entries(C.ECURIES).filter(([id]) => Number(id) < 10 || c.resultats.some((r) => r.ecurie === Number(id)));
    const deplacer = (i, d) => {
      const j = i + d;
      if (j < 0 || j >= c.resultats.length) return;
      [c.resultats[i], c.resultats[j]] = [c.resultats[j], c.resultats[i]];
      rendreEditeur();
    };

    const lignes = c.resultats.map((r, i) => {
      const estJoueur = r.pilote.startsWith("j:");
      const pilote = h("select", { onchange: (evt) => {
        const v = evt.target.value;
        if (v === "autre") {
          const etaitJoueur = r._original.pilote.startsWith("j:") || !r._original.pilote;
          r.pilote = etaitJoueur ? nouveauResultat().pilote : r._original.pilote;
          r.nom = etaitJoueur ? "" : r._original.nom;
        } else {
          const j = saison.joueurs.find((x) => `j:${x.id}` === v);
          r.pilote = v;
          r.nom = j.nom;
        }
        rendreEditeur();
      } },
        saison.joueurs.map((j) => option(`j:${j.id}`, j.nom, r.pilote === `j:${j.id}`)),
        option("autre", r.pilote.startsWith("inconnu:") ? "Joueur non reconnu" : "IA / autre", !estJoueur));
      const autoPoints = C.pointsDe({ ...r, pos: i + 1, pointsForces: null }, saison.bareme);
      return h("tr", {},
        h("td", { class: "num total" }, String(i + 1)),
        h("td", {}, h("button", { type: "button", class: "bouton-icone", title: "Monter", onclick: () => deplacer(i, -1) }, "↑"), " ",
          h("button", { type: "button", class: "bouton-icone", title: "Descendre", onclick: () => deplacer(i, 1) }, "↓")),
        h("td", {}, pilote, estJoueur ? null : [" ", h("input", { class: "nom", value: r.nom, placeholder: "Nom",
          oninput: (evt) => { r.nom = evt.target.value; } })]),
        h("td", {}, h("select", { onchange: (evt) => { r.ecurie = evt.target.value === "" ? null : Number(evt.target.value); } },
          option("", "—", r.ecurie == null), ecuries.map(([id, [nom]]) => option(id, nom, Number(id) === r.ecurie)))),
        h("td", {}, h("input", { type: "number", min: "0", max: "22", value: r.grille || "",
          oninput: (evt) => { r.grille = Number(evt.target.value) || 0; } })),
        h("td", {}, h("select", { onchange: (evt) => { r.statut = evt.target.value; rendreEditeur(); } },
          Object.entries(C.STATUTS).map(([v, t]) => option(v, t, v === r.statut)))),
        h("td", {}, h("input", { class: "temps", value: r.meilleurTour ? C.formatTemps(r.meilleurTour) : "", placeholder: "1:23.456",
          onchange: (evt) => { r.meilleurTour = C.lireTemps(evt.target.value); } })),
        h("td", {}, h("input", { type: "number", min: "0", value: r.penalites || "",
          oninput: (evt) => { r.penalites = Number(evt.target.value) || 0; } })),
        h("td", {}, h("input", { type: "number", value: r.pointsForces ?? "", placeholder: String(autoPoints), title: "Laisser vide pour le calcul automatique",
          oninput: (evt) => { r.pointsForces = evt.target.value === "" ? null : Number(evt.target.value); } })),
        h("td", {}, h("button", { type: "button", class: "bouton-icone", title: "Retirer ce pilote",
          onclick: () => { c.resultats.splice(i, 1); rendreEditeur(); } }, "✕")),
      );
    });

    zone.appendChild(h("div", { class: "tableau-defilant" }, h("table", { class: "editeur-table" },
      h("thead", {}, h("tr", {}, ["Pos", "", "Pilote", "Écurie", "Grille", "Statut", "Meilleur tour", "Pén. (s)", "Points", ""].map((t) => h("th", {}, t)))),
      h("tbody", {}, lignes))));
    zone.appendChild(h("p", { class: "indice" }, "L'ordre des lignes donne le classement. Points : laisse vide pour le barème automatique."));

    zone.appendChild(h("div", { class: "editeur-pied" },
      h("div", {},
        h("button", { type: "button", class: "bouton secondaire", onclick: () => { c.resultats.push(nouveauResultat()); rendreEditeur(); } }, "+ Ajouter un pilote"),
        edition.nouvelle ? null : h("button", { type: "button", class: "bouton danger", onclick: supprimerCourse }, "Supprimer la course")),
      h("div", {},
        h("button", { type: "button", class: "bouton secondaire", onclick: fermerEditeur }, "Annuler"),
        h("button", { type: "button", class: "bouton secondaire", onclick: () => enregistrerCourse(false) }, "Enregistrer sans publier"),
        h("button", { type: "button", class: "bouton", onclick: () => enregistrerCourse(true) }, "Enregistrer et publier")),
    ));
  }

  async function enregistrerCourse(publier) {
    const c = copie(edition.course);
    const vus = new Set();
    for (const r of c.resultats) {
      if (r.pilote.startsWith("j:")) {
        if (vus.has(r.pilote)) { alert(`${r.nom} apparaît deux fois dans le classement.`); return; }
        vus.add(r.pilote);
      } else if (!r.nom.trim()) {
        alert("Un pilote n'a pas de nom."); return;
      }
    }
    const autre = saison.courses.find((x) => x.id !== c.id && c.manche != null && x.manche === c.manche);
    if (autre && !confirm(`La manche ${c.manche} a déjà une course enregistrée. Les deux compteront. Continuer ?`)) return;

    const nouvelle = copie(saison);
    // Un pseudo non reconnu associé à un joueur devient un alias pour les prochaines courses
    const nomsInconnus = c.resultats.map((r) => r._original.pilote).filter((p) => p.startsWith("inconnu:"));
    for (const r of c.resultats) {
      const o = r._original;
      if (o.pilote.startsWith("inconnu:") && r.pilote.startsWith("j:")
          && nomsInconnus.filter((p) => p === o.pilote).length === 1) {
        const j = nouvelle.joueurs.find((x) => `j:${x.id}` === r.pilote);
        j.alias = [...new Set([...(j.alias || []), o.nom])];
      }
    }
    c.resultats.forEach((r, i) => { r.pos = i + 1; delete r._original; });
    const inconnus = c.resultats.filter((r) => r.pilote.startsWith("inconnu:"));
    c.remarques = inconnus.map((r) => `Joueur non reconnu : « ${r.nom} » (associe-le à l'un de vous)`);
    c.aVerifier = inconnus.length > 0;

    const i = nouvelle.courses.findIndex((x) => x.id === c.id);
    if (i >= 0) nouvelle.courses[i] = c; else nouvelle.courses.push(c);
    if (await sauver(nouvelle, publier, `Correction : ${libelleCourse(c)}`)) fermerEditeur();
  }

  async function supprimerCourse() {
    const c = edition.course;
    if (!confirm(`Supprimer définitivement « ${libelleCourse(c)} » ?`)) return;
    const nouvelle = copie(saison);
    nouvelle.courses = nouvelle.courses.filter((x) => x.id !== c.id);
    if (await sauver(nouvelle, true, `Suppression : ${libelleCourse(c)}`)) fermerEditeur();
  }

  function courseManuelle() {
    const calc = C.calculer(saison);
    const m = calc.prochaine;
    const precedente = calc.courses[calc.courses.length - 1];
    const resultats = precedente
      ? copie(precedente.resultats).sort((a, b) => a.pos - b.pos).map((r) => ({
          ...nouveauResultat(), pilote: r.pilote, nom: r.nom, ecurie: r.ecurie, numero: r.numero }))
      : saison.joueurs.map((j) => ({ ...nouveauResultat(), pilote: `j:${j.id}`, nom: j.nom }));
    ouvrirEditeur({
      id: `manuel-${Date.now()}`, manche: m ? m.manche : null, circuit: m ? m.circuit : null,
      date: new Date().toISOString().slice(0, 19), source: "manuel", aVerifier: false,
      remarques: precedente ? ["Pilotes repris de la course précédente : remets-les dans l'ordre d'arrivée."] : [],
      resultats: resultats.map((r, i) => ({ ...r, pos: i + 1 })),
    }, true);
  }

  async function depuisBrouillon() {
    try {
      const d = await api("GET", "/api/brouillon");
      ouvrirEditeur(d.course, true);
    } catch (e) {
      alert("Aucune course captée récemment par l'enregistreur.");
    }
  }

  // --- Réglages --------------------------------------------------------------

  function rendreReglages() {
    const zone = vider("reglages");
    const brouillon = copie(saison);
    const calc = C.calculer(saison);
    const aDesResultats = new Set(calc.classementPilotes.filter((p) => p.joueur).map((p) => p.id));

    zone.appendChild(h("div", { class: "champs" },
      h("label", {}, "Titre", h("input", { value: brouillon.titre, style: { width: "260px" }, oninput: (e) => { brouillon.titre = e.target.value; } })),
      h("label", {}, "Saison", h("input", { value: brouillon.saison || "", oninput: (e) => { brouillon.saison = e.target.value; } })),
    ));
    zone.appendChild(h("h3", {}, "Joueurs"));
    zone.appendChild(h("p", { class: "indice" },
      "Le pseudo en jeu sert à reconnaître chacun dans la télémétrie. Si un pseudo n'est pas reconnu pendant une séance, tu peux aussi l'associer directement dans le bloc Enregistreur."));
    brouillon.joueurs.forEach((j, i) => {
      zone.appendChild(h("div", { class: "ligne-joueur" },
        h("span", { class: "pastille", style: { background: `var(--j${(i % 8) + 1})`, marginBottom: "10px" } }),
        h("label", {}, "Nom affiché", h("input", { value: j.nom, oninput: (e) => { j.nom = e.target.value; } })),
        h("label", {}, "Pseudos en jeu (séparés par des virgules)",
          h("input", { class: "alias", value: (j.alias || []).join(", "),
            oninput: (e) => { j.alias = e.target.value.split(",").map((a) => a.trim()).filter(Boolean); } })),
        aDesResultats.has(`j:${j.id}`) ? null : h("button", { type: "button", class: "bouton danger",
          onclick: () => { brouillon.joueurs.splice(i, 1); sauver(brouillon, true, "Réglages"); } }, "Retirer"),
      ));
    });
    zone.appendChild(h("div", { class: "actions" },
      brouillon.joueurs.length < 8 ? h("button", { type: "button", class: "bouton secondaire", onclick: () => {
        const n = brouillon.joueurs.length + 1;
        brouillon.joueurs.push({ id: `joueur${Date.now().toString(36)}`, nom: `Joueur ${n}`, alias: [] });
        sauver(brouillon, false);
      } }, "+ Ajouter un joueur") : null,
      h("button", { type: "button", class: "bouton", onclick: () => {
        if (brouillon.joueurs.some((j) => !j.nom.trim())) { alert("Chaque joueur doit avoir un nom."); return; }
        sauver(brouillon, true, "Réglages du championnat");
      } }, "Enregistrer et publier"),
    ));
  }

  // --- Démarrage -------------------------------------------------------------

  document.getElementById("bouton-publier").addEventListener("click", () => api("POST", "/api/publier", { message: "Mise à jour du championnat" }).then(rafraichirEtat));
  document.getElementById("ajout-copie").addEventListener("click", courseManuelle);
  document.getElementById("ajout-brouillon").addEventListener("click", depuisBrouillon);
  document.getElementById("ajout-brouillon").hidden = false;
  document.getElementById("recharger").addEventListener("click", () => { fermerEditeur(); chargerSaison(); });

  chargerSaison().then(rafraichirEtat);
  setInterval(rafraichirEtat, 2000);
})();

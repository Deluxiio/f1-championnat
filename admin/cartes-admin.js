// Admin locale : gestion du jeu de cartes (économie, prix, raretés, boosters bonus, comptes).
(function () {
  "use strict";

  const C = window.Champ;
  const { h, option, api, copie } = window.Admin;
  const PAR_PAGE = 60;
  let catalogue = null;
  let revision = null;
  let bonus = {};          // idJoueur -> boosters bonus en cours d'édition
  let modifie = false;
  let serveur = { api: "", cleAdmin: "" };
  const filtres = { texte: "", rarete: "", modifiees: false, limite: PAR_PAGE };

  const vider = (id) => { const el = document.getElementById(id); el.replaceChildren(); return el; };
  const rarete = (id) => catalogue.raretes.find((r) => r.id === id);
  const nomEcurie = (id) => (catalogue.ecuries[id] ? catalogue.ecuries[id].nom : id);
  const sansAccents = (t) => t.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  const nombre = (v, min, max) => Math.min(max, Math.max(min, Math.round(Number(v) || 0)));

  function marquer() {
    modifie = true;
    rendreBarre();
  }

  // --- Chargement ------------------------------------------------------------

  async function charger() {
    const d = await api("GET", "/api/catalogue");
    catalogue = d.catalogue;
    revision = d.revision;
    const saison = window.Admin.saison();
    bonus = Object.fromEntries((saison ? saison.joueurs : []).map((j) => [j.id, j.boostersBonus || 0]));
    modifie = false;
    rendre();
  }

  function rendre() {
    rendreEconomie();
    rendreBoosters();
    rendreCatalogue();
    rendreBarre();
  }

  // --- Économie --------------------------------------------------------------

  function chanceAuMoinsUne(idRarete) {
    const total = catalogue.raretes.reduce((s, r) => s + r.poids, 0);
    const p = rarete(idRarete).poids / total;
    const ordre = catalogue.raretes.map((r) => r.id);
    const eligibles = catalogue.raretes.slice(0, ordre.indexOf(catalogue.derniereCarteMin) + 1);
    const totalDerniere = eligibles.reduce((s, r) => s + r.poids, 0);
    const pDerniere = eligibles.some((r) => r.id === idRarete) ? rarete(idRarete).poids / totalDerniere : 0;
    const n = catalogue.cartesParBooster;
    return 1 - Math.pow(1 - p, n - 1) * (1 - pDerniere);
  }

  function rendreEconomie() {
    const zone = vider("cartes-economie");
    const champ = (libelle, cle, min, max, aide) => h("label", {}, libelle,
      h("input", { type: "number", min: String(min), max: String(max), value: catalogue[cle], title: aide,
        onchange: (e) => { catalogue[cle] = nombre(e.target.value, min, max); marquer(); rendreEconomie(); rendreBoosters(); } }));
    zone.appendChild(h("div", { class: "champs" },
      champ("Points pour 1 booster", "pointsParBooster", 1, 100, "Ex. 5 : un booster tous les 5 points"),
      champ("Cartes par booster", "cartesParBooster", 1, 10),
      h("label", {}, "Dernière carte au minimum",
        h("select", { onchange: (e) => { catalogue.derniereCarteMin = e.target.value; marquer(); rendreEconomie(); } },
          catalogue.raretes.map((r) => option(r.id, r.nom, r.id === catalogue.derniereCarteMin)))),
    ));

    const total = catalogue.raretes.reduce((s, r) => s + r.poids, 0);
    const compte = (id) => catalogue.cartes.filter((c) => c.rarete === id).length;
    const entree = (r, cle) => h("input", { type: "number", min: "0", value: r[cle],
      onchange: (e) => { r[cle] = nombre(e.target.value, 0, 100000); marquer(); rendreEconomie(); } });
    zone.appendChild(h("div", { class: "tableau-defilant" }, h("table", {},
      h("thead", {}, h("tr", {}, ["Rareté", "Cartes", "Poids de tirage", "Chance par carte", "Au moins 1 par booster",
        "Valeur d'un doublon", "Prix de fabrication"].map((t) => h("th", {}, t)))),
      h("tbody", {}, catalogue.raretes.map((r) => h("tr", {},
        h("td", {}, h("strong", {}, r.nom)),
        h("td", { class: "num" }, String(compte(r.id))),
        h("td", {}, entree(r, "poids")),
        h("td", { class: "num" }, `${((100 * r.poids) / total).toFixed(1).replace(".", ",")} %`),
        h("td", { class: "num" }, `${(100 * chanceAuMoinsUne(r.id)).toFixed(1).replace(".", ",")} %`),
        h("td", {}, entree(r, "fragments"), " fragments"),
        h("td", {}, entree(r, "cout"), " fragments"),
      ))),
    )));
    zone.appendChild(h("p", { class: "indice" },
      "Le poids donne les chances relatives de chaque rareté pour chaque carte tirée. Le prix de fabrication s'applique à toutes les cartes de la rareté, sauf si une carte a son propre prix dans le catalogue ci-dessous."));
  }

  // --- Boosters par joueur ---------------------------------------------------

  function rendreBoosters() {
    const zone = vider("cartes-boosters");
    const saison = window.Admin.saison();
    if (!saison || !catalogue) return;
    const calc = C.calculer(saison);
    zone.appendChild(h("div", { class: "tableau-defilant" }, h("table", {},
      h("thead", {}, h("tr", {}, ["Joueur", "Points", "Boosters gagnés", "Bonus", "Total"].map((t) => h("th", {}, t)))),
      h("tbody", {}, calc.joueurs.map((p) => {
        const id = p.joueur.id;
        const gagnes = Math.floor(p.points / catalogue.pointsParBooster);
        return h("tr", {},
          h("td", {}, h("strong", {}, p.nom)),
          h("td", { class: "num" }, String(p.points)),
          h("td", { class: "num" }, String(gagnes)),
          h("td", {}, h("input", { type: "number", value: bonus[id] || 0, title: "Boosters offerts (ou retirés avec un nombre négatif)",
            onchange: (e) => { bonus[id] = nombre(e.target.value, -10000, 10000); marquer(); rendreBoosters(); } })),
          h("td", { class: "num total" }, String(Math.max(0, gagnes + (bonus[id] || 0)))),
        );
      })),
    )));
    zone.appendChild(h("p", { class: "indice" }, "Le bonus sert à offrir des boosters (un cadeau, une compensation après un bug…). Un nombre négatif en retire."));
  }

  // --- Catalogue ---------------------------------------------------------------

  function appliquer(carte) {
    const perso = carte.perso || {};
    carte.rarete = perso.rarete ?? carte.auto.rarete;
    carte.note = perso.note ?? carte.auto.note;
    carte.fait = perso.fait ?? carte.auto.fait;
    if (perso.cout != null) carte.cout = perso.cout; else delete carte.cout;
    if (!Object.keys(perso).length) delete carte.perso;
  }

  function personnaliser(carte, cle, valeur) {
    carte.perso = carte.perso || {};
    const parDefaut = cle === "cout" ? null : carte.auto[cle];
    if (valeur === null || valeur === "" || valeur === parDefaut) delete carte.perso[cle];
    else carte.perso[cle] = valeur;
    appliquer(carte);
    marquer();
  }

  function ligneCarte(carte) {
    const r = rarete(carte.rarete);
    const tr = h("tr", { class: carte.perso ? "est-joueur" : null },
      h("td", { class: "num" }, String(carte.numero).padStart(3, "0")),
      h("td", {}, h("strong", {}, `${carte.prenom} ${carte.nom}`)),
      h("td", {}, nomEcurie(carte.ecurie)),
      h("td", {}, carte.saisons),
      h("td", {}, h("select", { onchange: (e) => { personnaliser(carte, "rarete", e.target.value); tr.replaceWith(ligneCarte(carte)); } },
        catalogue.raretes.map((x) => option(x.id, x.nom + (x.id === carte.auto.rarete ? " (auto)" : ""), x.id === carte.rarete)))),
      h("td", {}, h("input", { type: "number", min: "1", max: "99", value: carte.note,
        onchange: (e) => { personnaliser(carte, "note", nombre(e.target.value, 1, 99)); tr.replaceWith(ligneCarte(carte)); } })),
      h("td", {}, h("input", { type: "number", min: "0", value: carte.cout ?? "", placeholder: String(r.cout),
        title: `Vide = prix de la rareté (${r.cout} fragments)`,
        onchange: (e) => { personnaliser(carte, "cout", e.target.value === "" ? null : nombre(e.target.value, 0, 100000)); tr.replaceWith(ligneCarte(carte)); } })),
      h("td", {}, h("input", { class: "fait", value: carte.fait,
        onchange: (e) => { personnaliser(carte, "fait", e.target.value.trim() || carte.auto.fait); tr.replaceWith(ligneCarte(carte)); } })),
      h("td", {}, carte.perso ? h("button", { type: "button", class: "bouton-icone", title: "Revenir aux valeurs automatiques",
        onclick: () => { delete carte.perso; appliquer(carte); marquer(); tr.replaceWith(ligneCarte(carte)); } }, "↺") : ""),
    );
    return tr;
  }

  function rendreCatalogue() {
    const zone = vider("cartes-catalogue");
    const filtrer = () => { filtres.limite = PAR_PAGE; rendreListe(); };
    zone.appendChild(h("div", { class: "champs" },
      h("label", {}, "Recherche", h("input", { value: filtres.texte, placeholder: "Pilote ou écurie",
        oninput: (e) => { filtres.texte = e.target.value; filtrer(); } })),
      h("label", {}, "Rareté", h("select", { onchange: (e) => { filtres.rarete = e.target.value; filtrer(); } },
        option("", "Toutes", !filtres.rarete), catalogue.raretes.map((r) => option(r.id, r.nom, r.id === filtres.rarete)))),
      h("label", {}, "Affichage", h("select", { onchange: (e) => { filtres.modifiees = e.target.value === "1"; filtrer(); } },
        option("0", "Toutes les cartes", !filtres.modifiees), option("1", "Cartes modifiées", filtres.modifiees))),
    ));
    zone.appendChild(h("div", { id: "cartes-liste" }));
    rendreListe();
  }

  function rendreListe() {
    const zone = vider("cartes-liste");
    const texte = sansAccents(filtres.texte);
    const liste = catalogue.cartes.filter((c) =>
      (!filtres.rarete || c.rarete === filtres.rarete)
      && (!filtres.modifiees || c.perso)
      && (!texte || sansAccents(`${c.prenom} ${c.nom} ${nomEcurie(c.ecurie)}`).includes(texte)));
    zone.appendChild(h("p", { class: "indice" }, `${liste.length} carte${liste.length > 1 ? "s" : ""}`));
    zone.appendChild(h("div", { class: "tableau-defilant" }, h("table", { class: "editeur-table" },
      h("thead", {}, h("tr", {}, ["N°", "Pilote", "Écurie", "Saisons", "Rareté", "Note", "Prix", "Phrase de la carte", ""].map((t) => h("th", {}, t)))),
      h("tbody", {}, liste.slice(0, filtres.limite).map(ligneCarte)),
    )));
    if (liste.length > filtres.limite) {
      zone.appendChild(h("button", { type: "button", class: "bouton secondaire", style: { marginTop: "10px" },
        onclick: () => { filtres.limite += PAR_PAGE * 2; rendreListe(); } }, `Afficher plus (${liste.length - filtres.limite} restantes)`));
    }
    zone.appendChild(h("p", { class: "indice" },
      "Les lignes surlignées ont été modifiées à la main. Prix vide = prix de la rareté. ↺ remet la carte comme calculée à partir du palmarès."));
  }

  // --- Enregistrement --------------------------------------------------------

  function rendreBarre() {
    const zone = vider("cartes-barre");
    zone.hidden = !modifie;
    if (!modifie) return;
    zone.appendChild(h("span", {}, "Modifications des cartes non enregistrées"));
    zone.appendChild(h("div", { class: "actions" },
      h("button", { type: "button", class: "bouton secondaire", onclick: () => { if (confirm("Annuler les modifications des cartes ?")) charger(); } }, "Annuler"),
      h("button", { type: "button", class: "bouton", onclick: enregistrer }, "Enregistrer et publier")));
  }

  async function enregistrer() {
    const saison = window.Admin.saison();
    const bonusChange = saison.joueurs.some((j) => (j.boostersBonus || 0) !== (bonus[j.id] || 0));
    if (bonusChange) {
      const nouvelle = copie(saison);
      for (const j of nouvelle.joueurs) {
        if (bonus[j.id]) j.boostersBonus = bonus[j.id]; else delete j.boostersBonus;
      }
      if (!(await window.Admin.sauverSaison(nouvelle, false))) return;
    }
    try {
      const d = await api("PUT", "/api/catalogue", { revision, catalogue, publier: true, message: "Réglages des cartes" });
      revision = d.revision;
      modifie = false;
      rendreBarre();
      alert("Enregistré et publié. Le serveur des cartes en tient compte d'ici 5 à 15 minutes.");
    } catch (e) {
      alert(e.message);
      if (e.statut === 409) charger();
    }
  }

  // --- Comptes (serveur des cartes) ------------------------------------------

  async function appelServeur(action, corps) {
    const r = await fetch(`${serveur.api}?action=${action}`, corps
      ? { method: "POST", headers: { "Content-Type": "text/plain;charset=UTF-8" }, body: JSON.stringify(corps) }
      : { cache: "no-store" });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.erreur || `Erreur ${r.status}`);
    return d;
  }

  async function rendreComptes() {
    const zone = vider("cartes-comptes");
    serveur = await api("GET", "/api/cartes-serveur");
    if (!serveur.api) {
      zone.appendChild(h("p", { class: "indice" },
        "Le serveur des cartes n'est pas encore branché : la page Cartes est en mode démo. Une fois api.php installé sur Hostinger, son adresse ira dans docs/cartes/config.js."));
      return;
    }
    let etat;
    try {
      etat = await appelServeur("etat");
    } catch (e) {
      zone.appendChild(h("p", {}, `Serveur injoignable (${serveur.api}) : ${e.message}`));
      return;
    }
    zone.appendChild(h("div", { class: "tableau-defilant" }, h("table", {},
      h("thead", {}, h("tr", {}, ["Joueur", "Mot de passe", "Cartes", "Boosters ouverts", "À ouvrir", "Fragments", ""].map((t) => h("th", {}, t)))),
      h("tbody", {}, etat.joueurs.map((j) => h("tr", {},
        h("td", {}, h("strong", {}, j.nom)),
        h("td", {}, j.compte ? "Défini" : "Pas encore"),
        h("td", { class: "num" }, `${j.nbCartes} / ${etat.totalCartes}`),
        h("td", { class: "num" }, `${j.boostersOuverts} / ${j.boostersGagnes}`),
        h("td", { class: "num" }, String(j.boostersDispo)),
        h("td", { class: "num" }, String(j.fragments)),
        h("td", {}, j.compte ? h("button", { type: "button", class: "bouton secondaire", onclick: async () => {
          if (!confirm(`Réinitialiser le mot de passe de ${j.nom} ? Sa collection est conservée ; il choisira un nouveau mot de passe à sa prochaine connexion.`)) return;
          try {
            await appelServeur("reinitialiser", { cle: serveur.cleAdmin, nom: j.nom });
            rendreComptes();
          } catch (e) {
            alert(e.message);
          }
        } }, "Réinitialiser le mot de passe") : ""),
      ))),
    )));
  }

  window.addEventListener("saison-chargee", () => { if (catalogue && !modifie) charger(); else if (catalogue) rendreBoosters(); });
  window.addEventListener("beforeunload", (e) => { if (modifie) { e.preventDefault(); e.returnValue = ""; } });
  document.getElementById("cartes-rafraichir-comptes").addEventListener("click", rendreComptes);
  charger().catch((e) => { document.getElementById("cartes-economie").textContent = `Catalogue illisible : ${e.message}`; });
  rendreComptes();
})();

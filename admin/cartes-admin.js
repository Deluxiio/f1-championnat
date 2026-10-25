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
  const decimal = (v, min, max) => Math.min(max, Math.max(min, Math.round((Number(v) || 0) * 100) / 100));
  const virgule = (x) => String(x).replace(".", ",");

  function marquer() {
    modifie = true;
    rendreBarre();
  }

  // --- Chargement ------------------------------------------------------------

  async function charger() {
    const d = await api("GET", "/api/catalogue");
    catalogue = d.catalogue;
    revision = d.revision;
    catalogue.minutesParBoosterOffert ??= 60;   // boosters offerts : valeurs par défaut d'un catalogue plus ancien
    catalogue.stockMaxBoostersOfferts ??= 10;
    catalogue.chanceMythiqueParBooster ??= 1;   // cartes Mythiques et pronostics : idem
    catalogue.pronosGainMeilleur ??= 2;
    catalogue.pronosGainOrdre ??= 4;
    catalogue.pronosGainMax ??= 60;
    catalogue.pronosLissage ??= 15;
    catalogue.spectateursMax ??= 30;            // spectateurs (joueurs extérieurs) : idem
    catalogue.boostersDepartSpectateur ??= 1;
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
        onchange: (e) => {
          if (e.target.value.trim() === "") { rendreEconomie(); return; }   // champ vidé : on garde l'ancienne valeur
          catalogue[cle] = nombre(e.target.value, min, max); marquer(); rendreEconomie(); rendreBoosters();
        } }));
    const champDecimal = (libelle, cle, min, max, aide) => h("label", {}, libelle,
      h("input", { type: "number", min: String(min), max: String(max), step: "0.1", value: catalogue[cle], title: aide,
        onchange: (e) => {
          if (e.target.value.trim() === "") { rendreEconomie(); return; }
          catalogue[cle] = decimal(e.target.value, min, max); marquer(); rendreEconomie(); rendreBoosters();
        } }));
    zone.appendChild(h("div", { class: "champs" },
      champ("Points pour 1 booster", "pointsParBooster", 1, 100, "Ex. 5 : un booster tous les 5 points"),
      champ("Cartes par booster", "cartesParBooster", 1, 10),
      h("label", {}, "Dernière carte au minimum",
        h("select", { onchange: (e) => { catalogue.derniereCarteMin = e.target.value; marquer(); rendreEconomie(); } },
          catalogue.raretes.filter((r) => r.id !== "mythique").map((r) => option(r.id, r.nom, r.id === catalogue.derniereCarteMin)))),
      champ("Minutes entre deux boosters offerts", "minutesParBoosterOffert", 0, 10080, "0 = désactivé. Ex. 60 : 1 booster offert par heure à chaque joueur"),
      champ("Stock maximum de boosters offerts", "stockMaxBoostersOfferts", 1, 100, "Quand le stock est plein, le compteur s'arrête jusqu'à la prochaine ouverture"),
      champDecimal("Chance d'une carte Mythique par booster (%)", "chanceMythiqueParBooster", 0, 100, "1 = environ 1 booster sur 100 contient la carte d'un des potes. 0 = aucune Mythique"),
    ));
    const minutes = catalogue.minutesParBoosterOffert;
    zone.appendChild(h("p", { class: "indice" }, minutes > 0
      ? `Boosters offerts : chaque joueur en reçoit 1 toutes les ${minutes} minutes, sans rien faire, et les garde en stock jusqu'à ${catalogue.stockMaxBoostersOfferts}. Ils s'ouvrent avant ceux gagnés avec les points. Si tu baisses le stock maximum, les stocks plus grands sont ramenés au nouveau plafond.`
      : "Boosters offerts désactivés : plus aucun nouveau booster n'est offert (le stock restant reste utilisable)."));

    const chanceMythique = catalogue.chanceMythiqueParBooster;
    zone.appendChild(h("p", { class: "indice" }, chanceMythique > 0
      ? `Cartes Mythiques (les 4 potes) : environ ${virgule(chanceMythique)} % des boosters en contiennent une (jamais plus d'une par booster), uniquement dans les boosters (jamais fabricable). Une Mythique que le joueur n'a pas encore passe avant un doublon ; un doublon vaut ${rarete("mythique") ? rarete("mythique").fragments : 0} fragments.`
      : "Cartes Mythiques désactivées : aucun booster n'en contient."));

    zone.appendChild(h("div", { class: "champs" },
      champ("Pronostics : boosters de base « meilleur d'entre nous »", "pronosGainMeilleur", 0, 1000, "Un pari juste rapporte ce nombre × la cote. 0 aux deux paris = pronostics désactivés"),
      champ("Pronostics : boosters de base « ordre d'arrivée »", "pronosGainOrdre", 0, 1000, "Un pari juste rapporte ce nombre × la cote. 0 aux deux paris = pronostics désactivés"),
      champ("Pronostics : gain maximum d'un pari", "pronosGainMax", 1, 1000, "Plafond de boosters pour un seul pari (le gros lot de l'ordre d'arrivée)"),
      champ("Pronostics : lissage des cotes", "pronosLissage", 1, 1000, "Points ajoutés à chaque joueur pour calculer les cotes : plus c'est grand, plus les cotes sont proches. Ex. 15"),
    ));
    zone.appendChild(h("p", { class: "indice" }, catalogue.pronosGainMeilleur > 0 || catalogue.pronosGainOrdre > 0
      ? "Pronostics : avant chaque GP, chacun devine le meilleur d'entre vous et l'ordre d'arrivée, sans rien miser. Un pari juste rapporte (boosters de base × cote), ajoutés aux boosters gagnés. Les cotes se calculent à l'ouverture du GP d'après les points au championnat (+ lissage) et restent figées jusqu'à la course ; un changement de réglage ne vaut qu'à partir du GP suivant."
      : "Pronostics désactivés (0 aux deux paris) : plus aucun GP ne s'ouvre. Celui déjà ouvert sera quand même réglé après sa course."));

    zone.appendChild(h("div", { class: "champs" },
      champ("Spectateurs : nombre maximum de comptes", "spectateursMax", 0, 100, "0 = inscriptions fermées (les comptes existants restent)"),
      champ("Spectateurs : boosters offerts à l'inscription", "boostersDepartSpectateur", 0, 100, "En plus des boosters offerts à l'heure, qui démarrent à l'inscription"),
    ));
    zone.appendChild(h("p", { class: "indice" }, catalogue.spectateursMax > 0
      ? `Spectateurs : des joueurs extérieurs au championnat créent eux-mêmes leur compte (un pseudo et un mot de passe) sur la page Cartes, jusqu'à ${catalogue.spectateursMax} comptes. Ils ne marquent pas de points : leurs boosters sont les boosters offerts (mêmes réglages que les pilotes, ${catalogue.boostersDepartSpectateur} à l'inscription) et ceux gagnés aux pronostics. Contre les robots : 5 inscriptions par heure et par connexion, 20 par heure au total. Les comptes se gèrent dans « Comptes des joueurs » plus bas.`
      : "Inscriptions de spectateurs fermées : plus personne ne peut créer de compte (les comptes existants continuent de fonctionner)."));

    const total = catalogue.raretes.reduce((s, r) => s + r.poids, 0);
    const compte = (id) => catalogue.cartes.filter((c) => c.rarete === id).length;
    const entree = (r, cle) => h("input", { type: "number", min: "0", value: r[cle],
      onchange: (e) => { r[cle] = nombre(e.target.value, 0, 100000); marquer(); rendreEconomie(); } });
    zone.appendChild(h("div", { class: "tableau-defilant" }, h("table", {},
      h("thead", {}, h("tr", {}, ["Rareté", "Cartes", "Poids de tirage", "Chance par carte", "Au moins 1 par booster",
        "Valeur d'un doublon", "Prix de fabrication"].map((t) => h("th", {}, t)))),
      h("tbody", {}, catalogue.raretes.map((r) => r.id === "mythique" ? h("tr", {},
        // La Mythique n'entre pas dans le tirage par poids : son propre tirage dépend du réglage « chance par booster »
        h("td", {}, h("strong", {}, r.nom)),
        h("td", { class: "num" }, String(compte(r.id))),
        h("td", {}, "Tirage à part"),
        h("td", { class: "num" }, `${virgule((chanceMythique / catalogue.cartesParBooster).toFixed(2))} %`),
        h("td", { class: "num" }, `${virgule(chanceMythique)} %`),
        h("td", {}, entree(r, "fragments"), " fragments"),
        h("td", {}, "Impossible"),
      ) : h("tr", {},
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
    const calc = C.calculer(saison, { avecPartis: true });
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
    zone.appendChild(h("p", { class: "indice" }, "Le bonus sert à offrir des boosters (un cadeau, une compensation après un bug…). Un nombre négatif en retire. Les boosters offerts à l'heure (réglage ci-dessus) s'ajoutent à ce total et ne sont pas comptés ici."));
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

  // Pronostics du GP en cours : état, fermeture / réouverture à la main, annulation d'un GP qui n'aura pas lieu
  function rendrePronosAdmin(etat) {
    const zone = vider("cartes-pronos");
    const p = etat && etat.pronos;
    if (!etat) { zone.appendChild(h("p", { class: "indice" }, "Disponible quand le serveur des cartes répond (voir ci-dessus).")); return; }
    if (!p) {
      zone.appendChild(h("p", { class: "indice" }, "Le serveur des cartes ne gère pas encore les pronostics : renvoie la dernière version de api.php sur Hostinger."));
      return;
    }
    // On indique le GP affiché : si, entre-temps, il a été réglé et le suivant ouvert, le serveur refuse au lieu d'agir sur le suivant
    const agir = async (action, confirmation) => {
      if (confirmation && !confirm(confirmation)) return;
      try { await appelServeur(action, { cle: serveur.cleAdmin, manche: p.manche }); } catch (e) { alert(e.message); }
      rendreComptes();
    };
    if (p.manche === null) {
      zone.appendChild(h("p", { class: "indice" }, p.actif
        ? "Aucun GP ouvert aux pronostics : le prochain s'ouvre dès que le précédent est enregistré."
        : "Pronostics désactivés (réglages ci-dessus : 0 aux deux paris)."));
    } else {
      const spectateurs = new Set((etat.spectateurs || []).map((x) => x.id));
      const ids = Object.keys(p.aParie || {});
      const pilotes = ids.filter((id) => !spectateurs.has(id)), invites = ids.filter((id) => spectateurs.has(id));
      const parie = (liste) => liste.filter((id) => p.aParie[id]).length;
      zone.appendChild(h("p", {}, h("strong", {}, `GP n°${p.manche} · ${p.gp}`), p.statut === "ouvert" ? " — pronostics ouverts" : " — pronostics fermés (course en cours)",
        `. ${parie(pilotes)} / ${pilotes.length} ont parié`, invites.length ? ` (et ${parie(invites)} / ${invites.length} spectateur${invites.length > 1 ? "s" : ""})` : "", ".",
        p.actif ? "" : " (Pronostics désactivés : plus de nouveau pari possible.)"));
      const courseEnregistree = (p.enAttente || []).some((x) => x.manche === p.manche);  // résultat connu : on ne peut plus rouvrir
      zone.appendChild(h("div", { class: "actions" },
        p.statut === "ouvert"
          ? h("button", { type: "button", class: "bouton secondaire", onclick: () => agir("pronosFermer") }, "Fermer maintenant")
          : (courseEnregistree ? null : h("button", { type: "button", class: "bouton secondaire", onclick: () => agir("pronosOuvrir",
            "Les paris de chacun sont révélés dès la fermeture : en rouvrant, chacun peut modifier le sien en connaissant ceux des autres. Rouvrir quand même ?") }, "Rouvrir")),
        h("button", { type: "button", class: "bouton danger", onclick: () => agir("pronosAnnuler",
          `Annuler les pronostics du GP ${p.gp} ? Aucun gain ne sera versé et le GP suivant s'ouvrira.`) }, "Annuler ce GP"),
      ));
    }
    if ((p.enAttente || []).length) {
      zone.appendChild(h("p", { class: "indice" }, `Course à vérifier : ${p.enAttente.map((x) => `n°${x.manche} ${x.gp}`).join(", ")}. Les pronostics de ce GP seront réglés dès que tu auras corrigé la course dans la liste ci-dessus (Courses → Modifier → Enregistrer et publier).`));
    }
    const dernier = (p.historique || [])[0];
    if (dernier) {
      const nom = (id) => (etat.joueurs.concat(etat.spectateurs || []).find((j) => j.id === id) || { nom: id }).nom;
      zone.appendChild(h("p", { class: "indice" }, dernier.resultat && dernier.resultat.annulee
        ? `Dernier GP réglé : n°${dernier.manche} ${dernier.gp} (annulé, aucun gain).`
        : `Dernier GP réglé : n°${dernier.manche} ${dernier.gp} — arrivée ${(dernier.resultat ? dernier.resultat.classement : []).map(nom).join(" › ")}. Gains : ${
          Object.entries(dernier.gains || {}).map(([id, g]) => `${nom(id)} +${g.meilleur + g.ordre}`).join(", ") || "aucun"}.`));
    }
    zone.appendChild(h("p", { class: "indice" },
      "Les pronostics se ferment tout seuls au départ de la course (l'enregistreur prévient le serveur) et se règlent tout seuls quelques minutes après son enregistrement. Ces boutons servent en cas de souci."));
  }

  async function rendreComptes() {
    const zone = vider("cartes-comptes");
    serveur = await api("GET", "/api/cartes-serveur");
    if (!serveur.api) {
      zone.appendChild(h("p", { class: "indice" },
        "Le serveur des cartes n'est pas encore branché : la page Cartes est en mode démo. Une fois api.php installé sur Hostinger, son adresse ira dans docs/cartes/config.js."));
      rendrePronosAdmin(null);
      return;
    }
    let etat;
    try {
      etat = await appelServeur("etat");
    } catch (e) {
      zone.appendChild(h("p", {}, `Serveur injoignable (${serveur.api}) : ${e.message}`));
      rendrePronosAdmin(null);
      return;
    }
    rendrePronosAdmin(etat);
    zone.appendChild(h("div", { class: "tableau-defilant" }, h("table", {},
      h("thead", {}, h("tr", {}, ["Joueur", "Mot de passe", "Cartes", "Boosters ouverts", "À ouvrir", "Dont pronostics", "Fragments", ""].map((t) => h("th", {}, t)))),
      h("tbody", {}, etat.joueurs.map((j) => h("tr", {},
        h("td", {}, h("strong", {}, j.nom)),
        h("td", {}, j.compte ? "Défini" : "À choisir"),
        h("td", { class: "num" }, `${j.nbCartes} / ${etat.totalCartes}`),
        h("td", { class: "num" }, `${j.boostersOuverts} / ${j.boostersGagnes}`),
        h("td", { class: "num" }, j.offerts ? `${j.boostersDispo} (dont ${j.offerts.stock} offerts)` : String(j.boostersDispo)),
        h("td", { class: "num" }, j.boostersPronos > 0 ? `+${j.boostersPronos}` : "–"),
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
    rendreSpectateursAdmin(zone, etat);
  }

  // Les spectateurs : liste, mot de passe oublié, suppression (le plafond et les boosters de départ se règlent dans « Économie »)
  function rendreSpectateursAdmin(zone, etat) {
    zone.appendChild(h("h3", {}, "Spectateurs"));
    if (!etat.inscriptions) {
      zone.appendChild(h("p", { class: "indice" }, "Le serveur des cartes ne gère pas encore les spectateurs : renvoie la dernière version de api.php sur Hostinger."));
      return;
    }
    const ins = etat.inscriptions;
    zone.appendChild(h("p", {}, `${etat.spectateurs.length} spectateur${etat.spectateurs.length > 1 ? "s" : ""} sur ${ins.max} places — inscriptions ${ins.ouvertes ? "ouvertes" : "fermées"}.`));
    if (!etat.spectateurs.length) {
      zone.appendChild(h("p", { class: "indice" }, "Personne ne s'est encore inscrit. Les inscriptions se font sur la page Cartes (« Créer un compte spectateur »)."));
      return;
    }
    const action = async (action, corps, confirmation) => {
      if (!confirm(confirmation)) return;
      try { await appelServeur(action, { cle: serveur.cleAdmin, ...corps }); rendreComptes(); } catch (e) { alert(e.message); }
    };
    zone.appendChild(h("div", { class: "tableau-defilant" }, h("table", {},
      h("thead", {}, h("tr", {}, ["Pseudo", "Mot de passe", "Inscrit le", "Cartes", "À ouvrir", "Dont pronostics", "Fragments", ""].map((t) => h("th", {}, t)))),
      h("tbody", {}, etat.spectateurs.map((s) => h("tr", {},
        h("td", {}, h("strong", {}, s.nom)),
        h("td", {}, s.compte ? "Défini" : "À choisir"),
        h("td", {}, s.cree ? new Date(s.cree * 1000).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" }) : "—"),
        h("td", { class: "num" }, `${s.nbCartes} / ${etat.totalCartes}`),
        h("td", { class: "num" }, s.offerts ? `${s.boostersDispo} (dont ${s.offerts.stock} offerts)` : String(s.boostersDispo)),
        h("td", { class: "num" }, s.boostersPronos > 0 ? `+${s.boostersPronos}` : "–"),
        h("td", { class: "num" }, String(s.fragments)),
        h("td", {},
          s.compte ? h("button", { type: "button", class: "bouton secondaire", onclick: () => action("reinitialiser", { nom: s.nom },
            `Réinitialiser le mot de passe de ${s.nom} ? Sa collection est conservée ; le premier mot de passe saisi avec ce pseudo devient le nouveau : préviens-le de se connecter tout de suite.`) }, "Réinitialiser le mot de passe") : "",
          h("button", { type: "button", class: "bouton danger", style: { marginLeft: "6px" }, onclick: () => action("supprimerSpectateur", { id: s.id },
            `Supprimer définitivement le compte de ${s.nom} ? Sa collection, ses paris et ses tirages sont effacés, et c'est irréversible.`) }, "Supprimer"),
        ),
      ))),
    )));
  }

  window.addEventListener("saison-chargee", () => { if (catalogue && !modifie) charger(); else if (catalogue) rendreBoosters(); });
  window.addEventListener("beforeunload", (e) => { if (modifie) { e.preventDefault(); e.returnValue = ""; } });
  document.getElementById("cartes-rafraichir-comptes").addEventListener("click", rendreComptes);
  const ancienneVersion = "L'enregistreur tourne avec une ancienne version : ferme sa fenêtre noire, relance Lancer.bat puis recharge cette page.";
  charger().catch((e) => {
    document.getElementById("cartes-economie").textContent = e.statut === 404 ? ancienneVersion : `Catalogue illisible : ${e.message}`;
  });
  rendreComptes().catch((e) => {
    if (e.statut === 404) document.getElementById("cartes-comptes").textContent = ancienneVersion;
  });
})();

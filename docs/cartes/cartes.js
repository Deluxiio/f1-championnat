/* Page Cartes pilotes — collection, boosters, fabrication.
   Toutes les données sont insérées via textContent (jamais de HTML injecté). */
(function () {
  'use strict';

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const XLINK_NS = 'http://www.w3.org/1999/xlink';
  const reduitMouvement = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const CLE_SESSION = 'f1cartes.session';
  const CLE_DERNIER_NOM = 'f1cartes.dernierNom';
  const CLE_DEMO = 'f1cartes.demo.v1';
  const BOOSTERS_DEMO = 40;
  const JOUEURS_DEMO = [
    { id: 'joueur1', nom: 'Valentin' }, { id: 'joueur2', nom: 'Christopher' },
    { id: 'joueur3', nom: 'Joris' }, { id: 'joueur4', nom: 'Mathieu' },
  ];
  const NB_PARTICULES = { commune: 0, peu_commune: 6, rare: 12, epique: 20, legendaire: 32, icone: 48, mythique: 72 };
  const COULEURS_RARETE = { commune: '#a4a4ae', peu_commune: '#2fbf71', rare: '#3b8ff5', epique: '#9b4dca', legendaire: '#e8b923', icone: '#ffffff', mythique: '#ff3b2f' };
  const PARTICULES_ICONE = ['#ff2d95', '#ff8a00', '#ffe600', '#2bff88', '#00c8ff', '#b36bff', '#ffffff'];
  const PARTICULES_MYTHIQUE = ['#e10600', '#ff7a00', '#ffd200', '#ffffff', '#ffd200'];

  const etat = {
    catalogue: null, cartes: new Map(), parRarete: new Map(), rang: new Map(), raretes: new Map(),
    api: null, demo: false, session: null, public: null, panne: false,
    albumJoueur: null, tuiles: new Map(), groupes: new Map(), albumConstruit: false,
    filtres: { recherche: '', rarete: '', ecurie: '', possession: 'toutes' },
    occupe: false, pioches: [], minuterie: null, nouvellesRecentes: new Set(),
    pilotes: new Map(), photosCassees: new Set(), creditsConstruits: false,
    offertsFin: null, prochainEssaiOfferts: 0, rafraichitOfferts: false, pauseOfferts: 10000, generation: 0,
    monPari: null, suiviPari: null, brouillon: null, envoiPari: false, rafraichitPronos: false, pronosVu: {}, ongletAffiche: null,
  };

  /* ====================================================================
     Utilitaires
     ==================================================================== */
  const $ = (id) => document.getElementById(id);
  function el(tag, cls, texte, attrs) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (texte !== undefined && texte !== null) e.textContent = texte;
    if (attrs) Object.keys(attrs).forEach((k) => e.setAttribute(k, attrs[k]));
    return e;
  }
  function svgEl(tag, attrs) {
    const e = document.createElementNS(SVG_NS, tag);
    if (attrs) Object.keys(attrs).forEach((k) => e.setAttribute(k, attrs[k]));
    return e;
  }
  const pad3 = (n) => String(n).padStart(3, '0');
  const normaliser = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const pluriel = (n, singulier, formePlurielle) => `${n} ${n > 1 ? (formePlurielle || singulier + 's') : singulier}`;
  const formaterNombre = (v) => (typeof v === 'number' ? v.toLocaleString('fr-FR') : (v === null || v === undefined ? '–' : String(v)));
  const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
  const delai = (ms) => (reduitMouvement ? Math.min(ms, 60) : ms);
  const rangDe = (rarete) => etat.rang.get(rarete) || 0;
  const texteRatio = () => {
    const ratio = (etat.catalogue && etat.catalogue.pointsParBooster) || 1;
    return ratio === 1 ? '1 point au championnat = 1 booster' : `${ratio} points au championnat = 1 booster`;
  };
  /* Chance (en %) qu'un booster contienne une carte Mythique : réglage de l'admin, 1 % par défaut (comme le serveur). */
  function chanceMythique() {
    const v = etat.catalogue ? etat.catalogue.chanceMythiqueParBooster : undefined;
    return typeof v === 'number' && isFinite(v) ? Math.max(0, Math.min(100, v)) : 1;
  }
  /* Les Mythiques ne sortent que si le serveur est à jour (il envoie alors le bloc « pronos », qui arrive avec elles) :
     tant qu'il ne l'est pas, on ne promet pas de pourcentage. Sans nouvelles du serveur, on affiche le réglage normalement. */
  const mythiquesActives = () => !etat.public || !!etat.public.pronos;
  /* Boosters offerts : 1 toutes les N minutes, mis en stock jusqu'à un plafond. Le serveur compte le temps ;
     ici on n'affiche que le stock et un compte à rebours. Sans champ « offerts » (ancien serveur), rien n'est affiché. */
  const offertsDe = (j) => (j && j.offerts) || null;
  function texteRythme(secondes) {
    const min = Math.round(secondes / 60);
    if (min === 1) return 'toutes les minutes';
    if (min === 60) return 'toutes les heures';
    if (min === 1440) return 'tous les jours';
    if (min % 1440 === 0) return `tous les ${min / 1440} jours`;
    return min % 60 === 0 ? `toutes les ${min / 60} heures` : `toutes les ${min} minutes`;
  }
  function reglageOfferts() {  // null si le serveur ne connaît pas les boosters offerts ou si le système est désactivé
    const o = (etat.public ? etat.public.joueurs : []).map((j) => j.offerts).find((x) => x && x.intervalle > 0);
    return o ? { intervalle: o.intervalle, max: o.max } : null;
  }
  function dureeCourte(secondes) {
    const s = Math.max(0, Math.ceil(secondes));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
    return h ? `${h} h ${String(m).padStart(2, '0')} min` : `${m}:${String(s % 60).padStart(2, '0')}`;
  }
  const rareteDe = (id) => etat.raretes.get(id) || { id, nom: id, regle: '', poids: 0, fragments: 0, cout: 0 };
  const nomEcurie = (id) => (etat.catalogue.ecuries[id] && etat.catalogue.ecuries[id].nom) || id;
  function couleursEcurie(id) {
    const e = etat.catalogue.ecuries[id];
    const c = (e && e.couleurs) || [];
    return [c[0] || '#888888', c[1] || '#dddddd', c[2] || '#222222'];
  }
  /* Les cartes des potes (Mythiques) portent leurs propres couleurs ; les autres, celles de leur écurie. */
  function couleursCarte(c) {
    const k = c && c.couleurs;
    return Array.isArray(k) && k.length >= 3 ? [k[0], k[1], k[2]] : couleursEcurie(c.ecurie);
  }
  function appliquerCouleurs(elem, couleurs) {
    elem.style.setProperty('--c1', couleurs[0]);
    elem.style.setProperty('--c2', couleurs[1]);
    elem.style.setProperty('--c3', couleurs[2]);
  }
  function formaterDate(iso) {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    const minutes = (Date.now() - d.getTime()) / 60000;
    if (minutes < 1) return 'à l’instant';
    if (minutes < 60) return `il y a ${Math.round(minutes)} min`;
    if (minutes < 24 * 60) return `il y a ${Math.round(minutes / 60)} h`;
    return `${d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' })} ${d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}`;
  }
  const stockage = {
    lire(cle) { try { const v = localStorage.getItem(cle); return v ? JSON.parse(v) : null; } catch (e) { return null; } },
    ecrire(cle, valeur) { try { localStorage.setItem(cle, JSON.stringify(valeur)); return true; } catch (e) { return false; } },
    effacer(cle) { try { localStorage.removeItem(cle); } catch (e) { /* stockage indisponible */ } },
  };
  /* === Pronostics : calculs des cotes et des gains — mêmes formules que serveur/api.php (testées l'une contre l'autre) === */
  const arrondiDixieme = (x) => Math.floor(x * 10 + 0.5 + 1e-9) / 10;
  function cotePronos(p, base, max) {
    const plafond = base > 0 ? Math.max(1.1, max / base) : 1.1;
    return arrondiDixieme(Math.min(plafond, Math.max(1.1, p > 0 ? 1 / p : plafond)));
  }
  function cotesMeilleur(forces, base, max) {
    let total = 0;
    Object.keys(forces).forEach((id) => { total += forces[id]; });
    const cotes = {};
    Object.keys(forces).forEach((id) => { cotes[id] = cotePronos(forces[id] / total, base, max); });
    return cotes;
  }
  function coteOrdre(forces, ordre, base, max) {
    let reste = 0;
    ordre.forEach((id) => { reste += forces[id]; });
    let p = 1;
    ordre.forEach((id) => { p *= forces[id] / reste; reste -= forces[id]; });
    return cotePronos(p, base, max);
  }
  function gainPronos(base, cote, max) {
    return base > 0 ? Math.min(max, Math.max(1, Math.floor(base * cote + 0.5 + 1e-9))) : 0;
  }
  /* === fin des calculs de pronostics === */

  let minuterieNotif = null;
  function notifier(message, type) {
    const n = $('notification');
    n.textContent = message;
    n.className = 'notification' + (type ? ' ' + type : '');
    n.hidden = false;
    clearTimeout(minuterieNotif);
    minuterieNotif = setTimeout(() => { n.hidden = true; }, 5000);
  }

  /* ====================================================================
     API distante (CORS, jeton dans le corps) et faux serveur de démo
     ==================================================================== */
  class ErreurApi extends Error {
    constructor(message, code) { super(message); this.code = code || 0; }
  }

  function apiDistante(url) {
    async function appel(action, corps) {
      const cible = url + (url.includes('?') ? '&' : '?') + 'action=' + encodeURIComponent(action);
      let reponse;
      try {
        reponse = corps
          ? await fetch(cible, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=UTF-8' }, body: JSON.stringify(corps) })
          : await fetch(cible, { method: 'GET', cache: 'no-store' });
      } catch (e) {
        throw new ErreurApi('Impossible de joindre le serveur. Vérifiez votre connexion et réessayez.', 0);
      }
      let donnees = null;
      try { donnees = await reponse.json(); } catch (e) { donnees = null; }
      if (!reponse.ok) throw new ErreurApi((donnees && donnees.erreur) || `Erreur du serveur (${reponse.status}).`, reponse.status);
      if (!donnees || typeof donnees !== 'object') throw new ErreurApi('Réponse du serveur illisible.', reponse.status);
      return donnees;
    }
    return {
      etat: () => appel('etat'),
      connexion: (nom, motDePasse) => appel('connexion', { nom, motDePasse }),
      ouvrir: (jeton, nombre) => appel('ouvrir', { jeton, nombre }),
      fabriquer: (jeton, carte) => appel('fabriquer', { jeton, carte }),
      pronostiquer: (jeton, meilleur, ordre, manche) => appel('pronostiquer', { jeton, meilleur, ordre, manche }),
      monPronostic: (jeton) => appel('monPronostic', { jeton }),
      deconnexion: (jeton) => appel('deconnexion', { jeton }),
    };
  }

  /* Faux serveur : mêmes réponses, mêmes règles qu'API.md, état dans localStorage. */
  function serveurDemo(catalogue) {
    let donnees = stockage.lire(CLE_DEMO);
    if (!donnees || donnees.version !== 1) donnees = { version: 1, joueurs: {}, jetons: {}, fil: [] };
    JOUEURS_DEMO.forEach((j) => {
      if (!donnees.joueurs[j.id]) donnees.joueurs[j.id] = { nom: j.nom, motDePasse: null, boostersOuverts: 0, fragments: 0, cartes: [] };
    });
    const sauver = () => stockage.ecrire(CLE_DEMO, donnees);
    const echec = (code, message) => { throw new ErreurApi(message, code); };
    const latence = async (valeur) => { await dormir(delai(150)); return valeur; };
    const rangLocal = (id) => catalogue.raretes.length - catalogue.raretes.findIndex((r) => r.id === id);
    const parRarete = {};
    catalogue.cartes.forEach((c) => { (parRarete[c.rarete] = parRarete[c.rarete] || []).push(c); });

    /* Boosters offerts : mêmes règles que calculerOfferts() / vueOfferts() de api.php (temps en secondes).
       En démo, chaque joueur démarre avec 3 boosters offerts pour voir le système, puis le temps réel s'écoule. */
    const maintenantS = () => Math.floor(Date.now() / 1000);
    const reglagesOfferts = () => ({
      intervalle: Math.trunc(Math.max(0, Math.min(525600, Number(catalogue.minutesParBoosterOffert ?? 60) || 0))) * 60,
      max: Math.trunc(Math.max(1, Math.min(1000, Number(catalogue.stockMaxBoostersOfferts ?? 10) || 1))),
    });
    function calculerOfferts(j, maintenant) {
      const { intervalle, max } = reglagesOfferts();
      if (!j.offerts) { j.offerts = { stock: 3, depuis: maintenant }; sauver(); }
      const stock = Math.min(max, Math.max(0, j.offerts.stock));
      const depuis = Math.min(maintenant, j.offerts.depuis);
      if (intervalle <= 0) return { stock, depuis: maintenant };
      const arrives = Math.floor((maintenant - depuis) / intervalle);
      if (stock + arrives >= max) return { stock: max, depuis: maintenant };
      return { stock: stock + arrives, depuis: depuis + arrives * intervalle };
    }
    function vueOfferts(j, maintenant) {
      const { intervalle, max } = reglagesOfferts();
      const { stock, depuis } = calculerOfferts(j, maintenant);
      if (intervalle <= 0 && stock === 0) return null;
      return {
        stock, max, intervalle, ouverts: j.offertsOuverts || 0,
        prochainDans: intervalle > 0 && stock < max ? Math.max(0, depuis + intervalle - maintenant) : null,
      };
    }

    function joueurParJeton(jeton) {
      const id = donnees.jetons[jeton];
      if (!id || !donnees.joueurs[id]) echec(401, 'Session expirée : reconnectez-vous.');
      return { id, j: donnees.joueurs[id] };
    }
    function tirerRarete(minimum) {
      const candidates = catalogue.raretes.filter((r) => !minimum || rangLocal(r.id) >= rangLocal(minimum));
      const total = candidates.reduce((s, r) => s + r.poids, 0);
      let x = Math.random() * total;
      for (const r of candidates) { x -= r.poids; if (x < 0) return r.id; }
      return candidates[candidates.length - 1].id;
    }
    function tirerCarte(rarete) {
      const liste = parRarete[rarete] || catalogue.cartes;
      return liste[Math.floor(Math.random() * liste.length)];
    }
    /* Cartes Mythiques : comme chanceMythiqueParBooster() / boosterAvecMythique() / tirerMythique() de api.php — un seul tirage
       par booster (jamais plus d'une Mythique), puis une place au hasard. `?mythique=100` force la chance (pour montrer l'effet),
       `?mythique=0` la supprime. */
    function chanceMythiqueParBooster() {
      const forcee = new URLSearchParams(location.search).get('mythique');
      const pourcent = forcee !== null && forcee !== '' && isFinite(Number(forcee)) ? Number(forcee) : chanceMythique();
      return Math.max(0, Math.min(100, pourcent)) / 100;
    }
    const boosterAvecMythique = (chance) => chance > 0 && (parRarete.mythique || []).length > 0 && Math.random() < chance;
    function tirerMythique(possedees) {
      const liste = parRarete.mythique;
      const nouvelles = liste.filter((c) => !possedees.has(c.id));
      const choix = nouvelles.length ? nouvelles : liste;
      return choix[Math.floor(Math.random() * choix.length)];
    }
    function ajouterAuFil(joueur, carte, fabriquee) {
      if (rangLocal(carte.rarete) < rangLocal('epique')) return;
      donnees.fil.unshift({ joueur, carte: carte.id, date: new Date().toISOString(), fabriquee });
      donnees.fil.length = Math.min(donnees.fil.length, 30);
    }
    const gagnesDe = (j) => BOOSTERS_DEMO + (j.boostersPronos || 0);  // boosters gagnés = points (fictifs) + gains aux pronostics
    function vueJoueur(id) {
      const j = donnees.joueurs[id];
      const offerts = vueOfferts(j, maintenantS());
      const vue = {
        id, nom: j.nom, compte: j.motDePasse !== null, points: BOOSTERS_DEMO,
        boostersGagnes: gagnesDe(j), boostersPronos: j.boostersPronos || 0, boostersOuverts: j.boostersOuverts,
        boostersDispo: Math.max(0, gagnesDe(j) - j.boostersOuverts) + (offerts ? offerts.stock : 0),
        fragments: j.fragments, cartes: j.cartes.slice(), nbCartes: j.cartes.length,
      };
      if (offerts) vue.offerts = offerts;
      return vue;
    }

    /* ---------- Pronostics : mêmes règles que api.php. En démo : un championnat fictif, et un bouton « Simuler la course » ---------- */
    const FORCES_DEMO = { joueur1: 58, joueur2: 83, joueur3: 44, joueur4: 73 };  // « points + 15 » d'un championnat imaginaire
    const GP_DEMO = ['Bahreïn', 'Arabie saoudite', 'Miami', 'Émilie-Romagne', 'Monaco', 'Espagne', 'Canada', 'Autriche'];
    const nbEntier = (v, defaut, min, max) => Math.trunc(typeof v === 'number' && isFinite(v) ? Math.max(min, Math.min(max, v)) : defaut);
    const reglagesPronos = () => ({
      meilleur: nbEntier(catalogue.pronosGainMeilleur, 2, 0, 1000),
      ordre: nbEntier(catalogue.pronosGainOrdre, 4, 0, 1000),
      max: nbEntier(catalogue.pronosGainMax, 60, 1, 100000),
    });
    const pronosActifsDemo = () => { const r = reglagesPronos(); return r.meilleur > 0 || r.ordre > 0; };
    function etatPronos() {
      if (!donnees.pronos) donnees.pronos = { manches: {}, forces: Object.assign({}, FORCES_DEMO), suivant: 4 };
      return donnees.pronos;
    }
    function mancheCourante() {
      const pr = etatPronos();
      const n = Object.keys(pr.manches).map(Number).sort((a, b) => a - b).find((k) => pr.manches[k].statut !== 'regle');
      return n === undefined ? null : [n, pr.manches[n]];
    }
    function synchroniserPronos() {
      const pr = etatPronos();
      if (mancheCourante() || !pronosActifsDemo()) return;
      const r = reglagesPronos(), n = pr.suivant, forces = Object.assign({}, pr.forces);
      pr.manches[n] = {
        statut: 'ouvert', gp: GP_DEMO[(n - 4) % GP_DEMO.length], bases: { meilleur: r.meilleur, ordre: r.ordre, max: r.max },
        forces, cotes: { meilleur: cotesMeilleur(forces, r.meilleur, r.max) }, paris: {},
      };
      sauver();
    }
    const sansHorodatage = (paris) => Object.fromEntries(Object.keys(paris).map((id) => [id, { meilleur: paris[id].meilleur || null, ordre: paris[id].ordre || null }]));
    function vuePronos() {
      synchroniserPronos();
      const pr = etatPronos(), courante = mancheCourante();
      const classement = JOUEURS_DEMO.map((j) => ({ joueur: j.id, boosters: 0, bonsMeilleur: 0, bonsOrdre: 0, paris: 0 }));
      const reglees = Object.keys(pr.manches).map(Number).filter((n) => pr.manches[n].statut === 'regle');
      const historique = reglees.sort((a, b) => b - a).map((n) => {
        const m = pr.manches[n];
        if (!(m.resultat && m.resultat.annulee)) {
          Object.keys(m.paris).forEach((id) => {
            const ligne = classement.find((c) => c.joueur === id), g = m.gains[id] || { meilleur: 0, ordre: 0 };
            if (!ligne) return;
            ligne.paris++; ligne.boosters += g.meilleur + g.ordre;
            ligne.bonsMeilleur += g.meilleur > 0 ? 1 : 0; ligne.bonsOrdre += g.ordre > 0 ? 1 : 0;
          });
        }
        return { manche: n, gp: m.gp, resultat: m.resultat, gains: m.gains, paris: sansHorodatage(m.paris) };
      });
      classement.sort((a, b) => (b.boosters - a.boosters) || ((b.bonsMeilleur + b.bonsOrdre) - (a.bonsMeilleur + a.bonsOrdre)));
      const vue = { actif: pronosActifsDemo(), manche: null, gp: null, statut: null, bases: null, forces: null, cotes: null, aParie: {}, enAttente: [], historique: historique.slice(0, 6), classement };
      if (courante) {
        const [n, m] = courante;
        Object.assign(vue, { manche: n, gp: m.gp, statut: m.statut, bases: m.bases, forces: m.forces, cotes: m.cotes });
        JOUEURS_DEMO.forEach((j) => { vue.aParie[j.id] = !!m.paris[j.id]; });
        if (m.statut !== 'ouvert') vue.paris = sansHorodatage(m.paris);
      }
      return vue;
    }
    function detailPari(m, pari) {
      const b = m.bases;
      const meilleur = pari.meilleur || null, ordre = pari.ordre || null;
      const coteM = meilleur !== null ? (m.cotes.meilleur[meilleur] ?? 1.1) : null;
      const coteO = ordre !== null ? coteOrdre(m.forces, ordre, b.ordre, b.max) : null;
      return {
        meilleur, ordre, cotes: { meilleur: coteM, ordre: coteO },
        gains: { meilleur: coteM !== null ? gainPronos(b.meilleur, coteM, b.max) : 0, ordre: coteO !== null ? gainPronos(b.ordre, coteO, b.max) : 0 },
      };
    }
    /* Règlement d'un GP (reglerManchePronos de api.php) : `classement` = les potes dans l'ordre d'arrivée. */
    function reglerManche(m, classement) {
      const ids = Object.keys(m.forces), bases = m.bases, gains = {};
      const annulee = classement.length < 2;
      if (!annulee) {
        Object.keys(m.paris).forEach((id) => {
          const pari = m.paris[id], g = { meilleur: 0, ordre: 0 };
          if (pari.meilleur && pari.meilleur === classement[0]) g.meilleur = gainPronos(bases.meilleur, m.cotes.meilleur[classement[0]] ?? 1.1, bases.max);
          if (pari.ordre && bases.ordre > 0) {
            const filtre = pari.ordre.filter((x) => classement.includes(x));
            if (filtre.length === classement.length && filtre.every((x, i) => x === classement[i])) g.ordre = gainPronos(bases.ordre, coteOrdre(m.forces, filtre, bases.ordre, bases.max), bases.max);
          }
          gains[id] = g;
          const j = donnees.joueurs[id];
          if (j && g.meilleur + g.ordre > 0) j.boostersPronos = (j.boostersPronos || 0) + g.meilleur + g.ordre;
        });
      }
      m.resultat = { course: 'demo', classement, absents: ids.filter((id) => !classement.includes(id)), annulee };
      m.gains = gains;
      m.statut = 'regle';
    }

    return {
      async etat() {
        return latence({ joueurs: JOUEURS_DEMO.map((j) => vueJoueur(j.id)), fil: donnees.fil.slice(0, 30), totalCartes: catalogue.cartes.length, pronos: vuePronos() });
      },
      async connexion(nom, motDePasse) {
        const joueur = JOUEURS_DEMO.find((j) => normaliser(j.nom) === normaliser(nom));
        if (!joueur) echec(404, 'Prénom inconnu.');
        const j = donnees.joueurs[joueur.id];
        if (typeof motDePasse !== 'string' || motDePasse.length < 4) echec(400, 'Le mot de passe doit faire au moins 4 caractères.');
        let premiereConnexion = false;
        if (j.motDePasse === null) { j.motDePasse = motDePasse; premiereConnexion = true; }
        else if (j.motDePasse !== motDePasse) echec(401, 'Mauvais mot de passe.');
        const jeton = 'demo-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
        donnees.jetons[jeton] = joueur.id;
        sauver();
        return latence({ jeton, joueur: joueur.id, nom: joueur.nom, premiereConnexion });
      },
      async ouvrir(jeton, nombre) {
        const { id, j } = joueurParJeton(jeton);
        const maintenant = maintenantS();
        const calcul = calculerOfferts(j, maintenant);
        let offerts = calcul.stock;
        const dispo = Math.max(0, gagnesDe(j) - j.boostersOuverts) + offerts;
        if (dispo <= 0) echec(409, 'Aucun booster disponible.');
        const n = Math.max(1, Math.min(100, Math.floor(Number(nombre) || 1), dispo));
        const possedees = new Set(j.cartes);
        const boosters = [];
        const chanceMyth = chanceMythiqueParBooster();
        for (let b = 0; b < n; b++) {
          const booster = [];
          const placeMythique = boosterAvecMythique(chanceMyth) ? Math.floor(Math.random() * catalogue.cartesParBooster) : -1;
          for (let k = 0; k < catalogue.cartesParBooster; k++) {
            const carte = k === placeMythique
              ? tirerMythique(possedees)
              : tirerCarte(tirerRarete(k === catalogue.cartesParBooster - 1 ? catalogue.derniereCarteMin : null));
            if (possedees.has(carte.id)) {
              const frag = rareteLocale(carte.rarete).fragments;
              j.fragments += frag;
              booster.push({ carte: carte.id, nouvelle: false, fragments: frag });
            } else {
              possedees.add(carte.id); j.cartes.push(carte.id);
              booster.push({ carte: carte.id, nouvelle: true, fragments: 0 });
              ajouterAuFil(id, carte, false);
            }
          }
          if (offerts > 0) { offerts--; j.offertsOuverts = (j.offertsOuverts || 0) + 1; } else { j.boostersOuverts++; }
          boosters.push(booster);
        }
        j.offerts = { stock: offerts, depuis: calcul.depuis };
        sauver();
        const reponse = {
          boosters, fragments: j.fragments, boostersOuverts: j.boostersOuverts,
          boostersDispo: Math.max(0, gagnesDe(j) - j.boostersOuverts) + offerts,
        };
        const vue = vueOfferts(j, maintenant);
        if (vue) reponse.offerts = vue;
        return latence(reponse);
      },
      async fabriquer(jeton, carteId) {
        const { id, j } = joueurParJeton(jeton);
        const carte = catalogue.cartes.find((c) => c.id === carteId);
        if (!carte) echec(404, 'Carte inconnue.');
        if (carte.rarete === 'mythique') echec(409, 'Les cartes Mythiques ne se fabriquent pas : elles se trouvent uniquement dans les boosters.');
        if (j.cartes.includes(carte.id)) echec(409, 'Vous possédez déjà cette carte.');
        const cout = carte.cout ?? rareteLocale(carte.rarete).cout;
        if (j.fragments < cout) echec(409, `Fragments insuffisants : il en faut ${cout}, vous en avez ${j.fragments}.`);
        j.fragments -= cout;
        j.cartes.push(carte.id);
        ajouterAuFil(id, carte, true);
        sauver();
        return latence({ carte: carte.id, fragments: j.fragments });
      },
      async pronostiquer(jeton, meilleur, ordre, manche) {
        const { id } = joueurParJeton(jeton);
        synchroniserPronos();
        if (!pronosActifsDemo()) echec(409, 'Les pronostics ne sont pas activés.');
        const courante = mancheCourante();
        if (!courante) echec(409, 'Aucun GP à pronostiquer pour le moment.');
        const [n, m] = courante;
        if (manche !== undefined && manche !== null && Number(manche) !== n) echec(409, 'Ce GP est terminé : un nouveau GP vient de s\'ouvrir, refais ton pronostic.');
        if (m.statut !== 'ouvert') echec(409, 'Les pronostics de ce GP sont fermés : la course a commencé.');
        const ids = Object.keys(m.forces);
        const m0 = meilleur === undefined ? null : meilleur, o0 = ordre === undefined ? null : ordre;
        if (m0 === null && o0 === null) echec(400, 'Choisis au moins un pronostic.');
        if (m0 !== null && (m.bases.meilleur <= 0 || typeof m0 !== 'string' || !ids.includes(m0))) echec(400, 'Pronostic « meilleur d\'entre nous » invalide.');
        if (o0 !== null) {
          const valide = m.bases.ordre > 0 && Array.isArray(o0) && o0.length === ids.length && o0.every((x) => typeof x === 'string') && ids.every((x) => o0.includes(x)) && new Set(o0).size === ids.length;
          if (!valide) echec(400, `Pronostic « ordre d\'arrivée » invalide : classe chacun des ${ids.length} joueurs une seule fois.`);
        }
        const pari = { meilleur: m0, ordre: o0 === null ? null : o0.slice() };
        m.paris[id] = pari;
        sauver();
        return latence({ ok: true, manche: n, statut: 'ouvert', pari: detailPari(m, pari) });
      },
      async monPronostic(jeton) {
        const { id } = joueurParJeton(jeton);
        synchroniserPronos();
        const courante = mancheCourante();
        const pari = courante ? courante[1].paris[id] : null;
        return latence({ manche: courante ? courante[0] : null, statut: courante ? courante[1].statut : null, pari: pari ? detailPari(courante[1], pari) : null });
      },
      /* Réservé à la démo : ferme les pronostics du GP en cours (ce que fait l'enregistreur au départ de la course). */
      async fermerPronos() {
        synchroniserPronos();
        const courante = mancheCourante();
        if (courante && courante[1].statut === 'ouvert') { courante[1].statut = 'ferme'; sauver(); }
        return latence({ ok: true });
      },
      /* Réservé à la démo : joue la course tout de suite (ordre au hasard, ou `?ordre=joueur2,joueur1,…`), les joueurs
         non connectés parient au hasard, puis le GP suivant s'ouvre. */
      async simulerCourse() {
        synchroniserPronos();
        const courante = mancheCourante();
        if (!courante) echec(409, 'Aucun GP à simuler.');
        const [n, m] = courante, ids = Object.keys(m.forces);
        const hasard = (liste) => liste.slice().sort(() => Math.random() - 0.5);
        const voulu = (new URLSearchParams(location.search).get('ordre') || '').split(',').filter((x) => ids.includes(x));
        const classement = voulu.length >= 2 ? voulu : hasard(ids);
        const connectes = new Set(Object.values(donnees.jetons));
        ids.filter((id) => !connectes.has(id) && !m.paris[id]).forEach((id) => {
          m.paris[id] = { meilleur: m.bases.meilleur > 0 ? hasard(ids)[0] : null, ordre: m.bases.ordre > 0 ? hasard(ids) : null };
        });
        reglerManche(m, classement);
        const pr = etatPronos();
        classement.forEach((id, i) => { pr.forces[id] += [25, 18, 15, 12, 10, 8][i] || 0; });
        pr.suivant = n + 1;
        synchroniserPronos();
        sauver();
        return latence({ ok: true, manche: n });
      },
      async deconnexion(jeton) {
        delete donnees.jetons[jeton];
        sauver();
        return latence({ ok: true });
      },
    };
    function rareteLocale(id) { return catalogue.raretes.find((r) => r.id === id) || { fragments: 0, cout: 0 }; }
  }

  /* ====================================================================
     Catalogue
     ==================================================================== */
  async function chargerCatalogue() {
    let reponse;
    try { reponse = await fetch('catalogue.json?t=' + Date.now(), { cache: 'no-store' }); }
    catch (e) { throw new Error('Catalogue injoignable.'); }
    if (!reponse.ok) throw new Error(`Catalogue introuvable (${reponse.status}).`);
    const cat = await reponse.json();
    if (!cat || !Array.isArray(cat.cartes) || !Array.isArray(cat.raretes)) throw new Error('Catalogue invalide.');
    etat.catalogue = cat;
    cat.raretes.forEach((r, i) => { etat.raretes.set(r.id, r); etat.rang.set(r.id, cat.raretes.length - i); etat.parRarete.set(r.id, []); });
    cat.cartes.forEach((c) => {
      etat.cartes.set(c.id, c);
      if (!etat.parRarete.has(c.rarete)) etat.parRarete.set(c.rarete, []);
      etat.parRarete.get(c.rarete).push(c);
      c.cle = normaliser(`${c.prenom} ${c.nom} ${nomEcurie(c.ecurie)} ${c.nationalite} ${c.pays || ''}`);
      if (c.pilote && !etat.pilotes.has(c.pilote)) etat.pilotes.set(c.pilote, { prenom: c.prenom, nom: c.nom });
    });
  }
  /* Cartes Mythiques (les potes) : leurs chiffres suivent le championnat. On les calcule ici avec champ.js d'après data/saison.json ;
     si le fichier est introuvable, chaque carte garde simplement les valeurs du catalogue. */
  async function chargerSaison() {
    try {
      const reponse = await fetch('../data/saison.json?t=' + Date.now(), { cache: 'no-store' });
      if (!reponse.ok) return;
      appliquerCartesVivantes(await reponse.json());
    } catch (e) { /* hors ligne, ou page ouverte hors du site */ }
  }
  function appliquerCartesVivantes(saison) {
    if (!window.Champ || !etat.catalogue || !saison || !Array.isArray(saison.joueurs) || !Array.isArray(saison.courses)) return;
    let calcul;
    try { calcul = window.Champ.calculer(saison); } catch (e) { return; }
    const ordinal = (n) => (n === 1 ? '1er' : `${n}e`);
    const [noteMin, noteMax] = rareteDe('mythique').notes || [88, 99];
    const maxPoints = Math.max(0, ...calcul.joueurs.map((p) => p.points));
    const rangs = new Map();
    calcul.classementPilotes.filter((p) => p.joueur).forEach((p, i) => rangs.set(p.joueur.id, i + 1));
    etat.catalogue.cartes.filter((c) => c.ami).forEach((c) => {
      const p = calcul.joueurs.find((x) => x.joueur && x.joueur.id === c.ami);
      if (!p) return;
      const s = p.stats, departs = p.resultats.filter((r) => r && r.statut !== 'absent').length;
      c.stats = Object.assign({}, c.stats, { titres: 0, victoires: s.victoires, podiums: s.podiums, poles: 0, departs, points: p.points, meilleur: s.meilleurResultat });
      if (departs === 0) return;
      c.note = noteMin + Math.round(((noteMax - noteMin) * p.points) / (maxPoints || 1));
      const rang = rangs.get(c.ami);
      c.fait = rang === 1
        ? `Leader de la bande : ${formaterNombre(p.points)} points, ${pluriel(s.victoires, 'victoire')} en ${departs} GP.`
        : `${ordinal(rang || 4)} de la bande : ${formaterNombre(p.points)} points en ${departs} GP${s.meilleurResultat ? `, meilleur résultat ${ordinal(s.meilleurResultat)}` : ''}.`;
    });
  }
  /* Photo du pilote (Wikimedia Commons, servie depuis photos/) ou null → casque. */
  function photoDe(c) {
    const pilotes = etat.catalogue && etat.catalogue.pilotes;
    if (!pilotes || !c || !c.pilote || etat.photosCassees.has(c.pilote)) return null;
    const p = pilotes[c.pilote];
    return p && typeof p.photo === 'string' && p.photo ? p : null;
  }
  function tronquer(texte, max) {
    const t = String(texte || '').replace(/\s+/g, ' ').trim();
    if (t.length <= max) return t;
    const coupe = t.slice(0, max - 1);
    const espace = coupe.lastIndexOf(' ');
    return (espace > max * 0.6 ? coupe.slice(0, espace) : coupe).replace(/[\s,;:·(–-]+$/, '') + '…';
  }
  function lienExterne(texte, url, cls) {
    if (!url) return el('span', cls, texte);
    return el('a', cls, texte, { href: url, target: '_blank', rel: 'noopener noreferrer' });
  }
  /* Ligne « Photo : auteur · licence · Wikimedia Commons » */
  function ligneCredit(p, cls) {
    const ligne = el('p', cls || 'credit');
    ligne.appendChild(el('span', null, 'Photo : '));
    ligne.appendChild(el('span', 'credit-auteur', tronquer(p.auteur || 'auteur inconnu', 60), { title: p.auteur || '' }));
    ligne.appendChild(el('span', null, ' · '));
    ligne.appendChild(lienExterne(p.licence || 'licence libre', p.lienLicence));
    ligne.appendChild(el('span', null, ' · '));
    ligne.appendChild(lienExterne('Wikimedia Commons', p.source));
    return ligne;
  }
  function statsAffichees(c) {
    const s = c.stats || {};
    if (c.ami) return [['Victoires', s.victoires || 0], ['Podiums', s.podiums || 0], ['Points', s.points || 0], ['GP', s.departs || 0]];
    const meilleur = s.meilleur === null || s.meilleur === undefined ? '–' : (s.meilleur === 1 ? '1er' : `${s.meilleur}e`);
    if (s.titres > 0) return [['Titres', s.titres], ['Victoires', s.victoires], ['Podiums', s.podiums], ['Poles', s.poles]];
    if (s.victoires > 0) return [['Victoires', s.victoires], ['Podiums', s.podiums], ['Poles', s.poles], ['Départs', s.departs]];
    if (s.podiums > 0) return [['Podiums', s.podiums], ['Poles', s.poles], ['Points', s.points], ['Départs', s.departs]];
    if (s.points > 0) return [['Points', s.points], ['Meilleur', meilleur], ['Podiums', s.podiums], ['Départs', s.departs]];
    return [['Départs', s.departs], ['Meilleur', meilleur], ['Points', s.points], ['Podiums', s.podiums]];
  }

  /* ====================================================================
     Drapeaux dessinés (bandes, croix, formes simples) — repli : badge du code
     ==================================================================== */
  const DRAPEAUX = {
    GER: ['h', '#000000', '#DD0000', '#FFCE00'], AUT: ['h', '#ED2939', '#FFFFFF', '#ED2939'], NED: ['h', '#AE1C28', '#FFFFFF', '#21468B'],
    RUS: ['h', '#FFFFFF', '#0039A6', '#D52B1E'], HUN: ['h', '#CE2939', '#FFFFFF', '#477050'], ARG: ['h', '#74ACDF', '#FFFFFF', '#74ACDF'],
    VEN: ['h', '#FFCC00', '#00247D', '#CF142B'], POL: ['h', '#FFFFFF', '#DC143C'], INA: ['h', '#CE1126', '#FFFFFF'], MON: ['h', '#CE1126', '#FFFFFF'],
    COL: ['h', '#FCD116', '#FCD116', '#003893', '#CE1126'], ESP: ['h', '#AA151B', '#F1BF00', '#F1BF00', '#AA151B'],
    THA: ['h', '#A51931', '#F4F5F8', '#2D2A4A', '#2D2A4A', '#F4F5F8', '#A51931'], IND: ['h', '#FF9933', '#FFFFFF', '#138808'],
    FRA: ['v', '#0055A4', '#FFFFFF', '#EF4135'], ITA: ['v', '#009246', '#FFFFFF', '#CE2B37'], BEL: ['v', '#000000', '#FAE042', '#ED2939'],
    IRL: ['v', '#169B62', '#FFFFFF', '#FF883E'], MEX: ['v', '#006847', '#FFFFFF', '#CE1126'],
    FIN: ['croix', '#FFFFFF', '#003580'], SWE: ['croix', '#006AA7', '#FECC00'], DEN: ['croix', '#C60C30', '#FFFFFF'],
    GBR: ['gbr'], USA: ['usa'], BRA: ['bra'], JPN: ['jpn'], CHN: ['chn'], CAN: ['can'], AUS: ['aus'], NZL: ['nzl'], SUI: ['sui'], POR: ['por'], CZE: ['cze'], MAS: ['mas'],
    F1: ['damier'],  // les potes : pas de pays, le drapeau à damier
  };
  function etoile(cx, cy, r) {
    const pts = [];
    for (let i = 0; i < 10; i++) {
      const a = -Math.PI / 2 + (i * Math.PI) / 5;
      const rr = i % 2 ? r * 0.4 : r;
      pts.push(`${(cx + rr * Math.cos(a)).toFixed(2)},${(cy + rr * Math.sin(a)).toFixed(2)}`);
    }
    return pts.join(' ');
  }
  function unionJack(s, w, h) {
    const g = svgEl('g');
    s.appendChild(g);
    const add = (tag, attrs) => g.appendChild(svgEl(tag, attrs));
    add('rect', { x: 0, y: 0, width: w, height: h, fill: '#012169' });
    add('path', { d: `M0 0 L${w} ${h} M${w} 0 L0 ${h}`, stroke: '#FFFFFF', 'stroke-width': h * 0.3 });
    add('path', { d: `M0 0 L${w} ${h} M${w} 0 L0 ${h}`, stroke: '#C8102E', 'stroke-width': h * 0.1 });
    add('path', { d: `M${w / 2} 0 V${h} M0 ${h / 2} H${w}`, stroke: '#FFFFFF', 'stroke-width': h * 0.33 });
    add('path', { d: `M${w / 2} 0 V${h} M0 ${h / 2} H${w}`, stroke: '#C8102E', 'stroke-width': h * 0.2 });
  }
  function drapeau(code) {
    const def = DRAPEAUX[code];
    if (!def) return el('span', 'drapeau-code', code || '?', { title: code || '' });
    const s = svgEl('svg', { viewBox: '0 0 30 20', class: 'drapeau', role: 'img' });
    const titre = svgEl('title'); titre.textContent = code; s.appendChild(titre);
    const rect = (x, y, w, h, f) => s.appendChild(svgEl('rect', { x, y, width: w, height: h, fill: f }));
    const cercle = (cx, cy, r, f) => s.appendChild(svgEl('circle', { cx, cy, r, fill: f }));
    const poly = (points, f) => s.appendChild(svgEl('polygon', { points, fill: f }));
    const type = def[0];
    if (type === 'h') {
      const bandes = def.slice(1), hb = 20 / bandes.length;
      bandes.forEach((f, i) => rect(0, i * hb, 30, hb + 0.2, f));
      if (code === 'IND') s.appendChild(svgEl('circle', { cx: 15, cy: 10, r: 2.6, fill: 'none', stroke: '#000080', 'stroke-width': 1 }));
    } else if (type === 'v') {
      const bandes = def.slice(1), wb = 30 / bandes.length;
      bandes.forEach((f, i) => rect(i * wb, 0, wb + 0.2, 20, f));
      if (code === 'MEX') cercle(15, 10, 2.4, '#6B4A2B');
    } else if (type === 'croix') {
      rect(0, 0, 30, 20, def[1]); rect(9, 0, 5, 20, def[2]); rect(0, 7.5, 30, 5, def[2]);
    } else if (type === 'gbr') {
      unionJack(s, 30, 20);
    } else if (type === 'usa') {
      rect(0, 0, 30, 20, '#FFFFFF');
      for (let i = 0; i < 13; i += 2) rect(0, (i * 20) / 13, 30, 20 / 13 + 0.1, '#B22234');
      rect(0, 0, 12, 10.8, '#3C3B6E');
    } else if (type === 'bra') {
      rect(0, 0, 30, 20, '#009C3B'); poly('15,2.5 27,10 15,17.5 3,10', '#FFDF00'); cercle(15, 10, 4.6, '#002776');
    } else if (type === 'jpn') {
      rect(0, 0, 30, 20, '#FFFFFF'); cercle(15, 10, 6, '#BC002D');
    } else if (type === 'chn') {
      rect(0, 0, 30, 20, '#DE2910'); poly(etoile(6, 7, 4.5), '#FFDE00');
      [[12, 3], [14, 6], [14, 9.5], [12, 12.5]].forEach((p) => cercle(p[0], p[1], 0.9, '#FFDE00'));
    } else if (type === 'can') {
      rect(0, 0, 30, 20, '#FFFFFF'); rect(0, 0, 7.5, 20, '#FF0000'); rect(22.5, 0, 7.5, 20, '#FF0000');
      poly('15,3 16.6,6.4 19.2,5.6 18.4,9 21.5,10.6 18.6,12.2 19.2,14.6 15.8,14 15,17.5 14.2,14 10.8,14.6 11.4,12.2 8.5,10.6 11.6,9 10.8,5.6 13.4,6.4', '#FF0000');
    } else if (type === 'aus' || type === 'nzl') {
      rect(0, 0, 30, 20, '#00247D');
      unionJack(s, 15, 10);
      if (type === 'aus') { cercle(7.5, 15, 1.8, '#FFFFFF'); [[22, 4], [26, 8], [22, 13], [18, 9], [24, 16]].forEach((p) => cercle(p[0], p[1], 1, '#FFFFFF')); }
      else [[22, 5], [26, 9], [22, 14], [18, 9]].forEach((p) => { cercle(p[0], p[1], 1.5, '#FFFFFF'); cercle(p[0], p[1], 1, '#CC142B'); });
    } else if (type === 'sui') {
      rect(0, 0, 30, 20, '#D52B1E'); rect(13, 4, 4, 12, '#FFFFFF'); rect(9, 8, 12, 4, '#FFFFFF');
    } else if (type === 'por') {
      rect(0, 0, 12, 20, '#006600'); rect(12, 0, 18, 20, '#FF0000'); cercle(12, 10, 4, '#FFE800'); cercle(12, 10, 2.2, '#FF0000');
    } else if (type === 'cze') {
      rect(0, 0, 30, 10, '#FFFFFF'); rect(0, 10, 30, 10, '#D7141A'); poly('0,0 15,10 0,20', '#11457E');
    } else if (type === 'damier') {
      rect(0, 0, 30, 20, '#FFFFFF');
      for (let y = 0; y < 4; y++) for (let x = 0; x < 6; x++) if ((x + y) % 2 === 0) rect(x * 5, y * 5, 5, 5, '#111111');
    } else if (type === 'mas') {
      rect(0, 0, 30, 20, '#FFFFFF');
      for (let i = 0; i < 14; i += 2) rect(0, (i * 20) / 14, 30, 20 / 14 + 0.1, '#CC0001');
      rect(0, 0, 15, 11.5, '#010066'); cercle(6, 5.7, 3.4, '#FFCC00'); cercle(7.2, 5.7, 2.9, '#010066'); cercle(10.5, 5.7, 1.4, '#FFCC00');
    }
    return s;
  }

  /* ====================================================================
     Composants carte
     ==================================================================== */
  function useSvg(id, cls, viewBox) {
    const s = svgEl('svg', { viewBox, 'aria-hidden': 'true', class: cls });
    const u = svgEl('use', { href: '#' + id });
    u.setAttributeNS(XLINK_NS, 'xlink:href', '#' + id);
    s.appendChild(u);
    return s;
  }
  const casqueSvg = () => useSvg('casque', 'casque', '0 0 200 200');
  const couronneSvg = () => useSvg('couronne', 'couronne', '0 0 24 24');
  function gemmes(rarete) {
    const g = el('i', 'gemmes', null, { 'aria-hidden': 'true' });
    const n = rarete === 'mythique' ? 1 : rangDe(rarete);  // la Mythique n'a qu'un seul symbole : le damier
    for (let i = 0; i < n; i++) g.appendChild(el('b'));
    return g;
  }
  function etiquetteRarete(rarete) {
    const s = el('span', 'rarete');
    if (rarete === 'icone') s.appendChild(couronneSvg());
    s.appendChild(gemmes(rarete));
    s.appendChild(el('span', 'rarete-nom', rareteDe(rarete).nom));
    return s;
  }

  function creerCarte(c, options) {
    options = options || {};
    const r = rareteDe(c.rarete);
    const carte = el('div', `carte format r-${c.rarete}`);
    appliquerCouleurs(carte, couleursCarte(c));
    carte.setAttribute('role', 'img');
    carte.setAttribute('aria-label', `${c.prenom} ${c.nom} (${nomEcurie(c.ecurie)}), carte ${r.nom}, note ${c.note}`);
    const c3d = el('div', 'carte-3d');
    const face = el('div', 'face');

    const tete = el('header', 'tete');
    tete.append(el('span', 'numero', `${pad3(c.numero)}/${etat.catalogue.cartes.length}`), etiquetteRarete(c.rarete));
    face.appendChild(tete);

    const illu = el('div', 'illu');
    const photo = photoDe(c);
    if (photo) {
      illu.classList.add('avec-photo');
      carte.classList.add('avec-photo');
      const img = el('img', 'photo', null, { src: photo.photo, alt: '', decoding: 'async' });
      if (options.paresseux) img.setAttribute('loading', 'lazy');
      const voile = el('div', 'voile');
      img.addEventListener('error', () => {
        etat.photosCassees.add(c.pilote);
        illu.classList.remove('avec-photo');
        carte.classList.remove('avec-photo');
        voile.remove();
        img.replaceWith(casqueSvg());
      });
      illu.append(img, voile);
    } else {
      illu.appendChild(casqueSvg());
    }
    const note = el('div', 'note', String(c.note));
    note.appendChild(el('small', null, 'Note'));
    illu.appendChild(note);
    if (c.numeroCourse) illu.appendChild(el('div', 'num-course', String(c.numeroCourse)));
    face.appendChild(illu);

    const identite = el('div', 'identite');
    identite.append(el('div', 'prenom', c.prenom), el('div', 'nom', c.nom));
    const meta = el('div', 'meta');
    meta.append(drapeau(c.nationalite), el('span', null, c.nationalite), el('span', 'sep', '·'), el('span', 'ecurie', nomEcurie(c.ecurie)));
    identite.appendChild(meta);
    face.appendChild(identite);

    const lignes = statsAffichees(c);
    const stats = el('ul', 'stats');
    lignes.forEach(([label, valeur]) => {
      const li = el('li');
      li.append(el('b', null, formaterNombre(valeur)), el('span', null, label));
      stats.appendChild(li);
    });
    face.appendChild(stats);
    face.appendChild(el('p', 'fait', c.fait || ''));

    const annees = el('footer', 'annees');
    annees.appendChild(el('span', null, c.saisons || ''));
    const s = c.stats || {};
    if (!c.ami && typeof s.departs === 'number' && !lignes.some((l) => l[0] === 'Départs')) annees.appendChild(el('span', null, `${formaterNombre(s.departs)} départs`));
    face.appendChild(annees);

    for (let i = 0; i < 4; i++) face.appendChild(el('i', `coin coin-${i}`));
    face.append(el('div', 'cadre'), el('div', 'holo'), el('div', 'reflet'));
    c3d.appendChild(face);
    if (options.manquante) { carte.classList.add('manquante'); c3d.appendChild(el('span', 'ruban-manquante', 'Manquante')); }
    carte.appendChild(c3d);
    activerInclinaison(carte);
    if (options.cliquable) {
      carte.classList.add('cliquable');
      carte.addEventListener('click', () => ouvrirLoupe(c, joueurConnecte()));
    }
    return carte;
  }

  function creerDos() {
    const dos = el('div', 'dos');
    appliquerCouleurs(dos, ['#1f1f2b', '#e10600', '#ffffff']);
    dos.appendChild(el('i', 'filet'));
    dos.appendChild(el('span', 'marque haut', 'Championnat F1 25'));
    const emb = el('div', 'embleme');
    emb.appendChild(casqueSvg());
    dos.appendChild(emb);
    const bas = el('span', 'marque bas', 'Collection pilotes');
    bas.appendChild(el('small', null, `${(etat.catalogue && etat.catalogue.premiereSaison) || 2000} — aujourd’hui`));
    dos.appendChild(bas);
    return dos;
  }

  function creerMini(c) {
    const m = el('div', `mini r-${c.rarete} manque`);
    m.dataset.id = c.id;
    m.title = `${c.prenom} ${c.nom} · ${nomEcurie(c.ecurie)} · ${rareteDe(c.rarete).nom}`;
    m.append(el('span', 'mini-num', pad3(c.numero)), casqueSvg(), el('span', 'mini-nom', c.nom), el('span', 'mini-ecurie', nomEcurie(c.ecurie)), gemmes(c.rarete));
    return m;
  }
  function marquerTuile(m, c, possede) {
    m.classList.toggle('manque', !possede);
    m.classList.toggle('possede', possede);
    if (possede) appliquerCouleurs(m, couleursCarte(c));
    else ['--c1', '--c2', '--c3'].forEach((v) => m.style.removeProperty(v));
    /* Photo ronde seulement sur les cartes possédées ; les manquantes gardent la silhouette (surprise). */
    const photo = possede ? photoDe(c) : null;
    const actuel = m.querySelector('.mini-photo, .casque');
    const estPhoto = !!(actuel && actuel.classList.contains('mini-photo'));
    if (photo && !estPhoto) {
      const img = el('img', 'mini-photo', null, { src: photo.photo, alt: '', loading: 'lazy', decoding: 'async' });
      img.addEventListener('error', () => { etat.photosCassees.add(c.pilote); img.replaceWith(casqueSvg()); });
      if (actuel) actuel.replaceWith(img); else m.insertBefore(img, m.children[1] || null);
    } else if (!photo && estPhoto) {
      actuel.replaceWith(casqueSvg());
    }
  }

  function activerInclinaison(carte) {
    if (reduitMouvement) return;
    carte.addEventListener('pointermove', (e) => {
      const r = carte.getBoundingClientRect();
      if (!r.width || !r.height) return;
      const px = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
      const py = Math.min(1, Math.max(0, (e.clientY - r.top) / r.height));
      carte.classList.add('actif');
      carte.style.setProperty('--rx', `${((0.5 - py) * 24).toFixed(2)}deg`);
      carte.style.setProperty('--ry', `${((px - 0.5) * 24).toFixed(2)}deg`);
      carte.style.setProperty('--mx', `${(px * 100).toFixed(1)}%`);
      carte.style.setProperty('--my', `${(py * 100).toFixed(1)}%`);
      carte.style.setProperty('--hx', `${((1 - px) * 100).toFixed(1)}%`);
      carte.style.setProperty('--hy', `${((1 - py) * 100).toFixed(1)}%`);
    });
    carte.addEventListener('pointerleave', () => {
      carte.classList.remove('actif');
      ['--rx', '--ry', '--mx', '--my', '--hx', '--hy'].forEach((v) => carte.style.removeProperty(v));
    });
  }

  /* ====================================================================
     Session et joueurs
     ==================================================================== */
  function joueurConnecte() {
    if (!etat.session || !etat.public) return null;
    return etat.public.joueurs.find((j) => j.id === etat.session.joueur) || null;
  }
  function joueurAlbum() {
    const id = etat.albumJoueur || (etat.session && etat.session.joueur);
    if (!id || !etat.public) return null;
    return etat.public.joueurs.find((j) => j.id === id) || null;
  }
  function couleurJoueur(j) {
    const i = etat.public ? etat.public.joueurs.indexOf(j) : -1;
    return `var(--j${((i < 0 ? 0 : i) % 8) + 1})`;
  }
  function compterRaretes(ids) {
    const comptes = {};
    (ids || []).forEach((id) => { const c = etat.cartes.get(id); if (c) comptes[c.rarete] = (comptes[c.rarete] || 0) + 1; });
    return comptes;
  }
  function effacerSession() {
    etat.session = null;
    stockage.effacer(CLE_SESSION);
    etat.albumJoueur = null;
    etat.nouvellesRecentes.clear();
    etat.offertsFin = null;
    etat.monPari = null;
    etat.suiviPari = null;
    etat.brouillon = null;
  }
  function gererErreur(e) {
    if (e && e.code === 401) {
      effacerSession();
      rendreTout();
      notifier('Session expirée : reconnectez-vous.');
      ouvrirConnexion();
      return;
    }
    notifier((e && e.message) || 'Une erreur est survenue.');
  }
  /* Date (locale) d'arrivée du prochain booster offert, calculée à partir des secondes restantes données par le serveur :
     l'horloge du navigateur n'a donc aucune influence sur le moment où le booster arrive. */
  function synchroniserOfferts() {
    const o = offertsDe(joueurConnecte());
    etat.offertsFin = o && typeof o.prochainDans === 'number' ? Date.now() + o.prochainDans * 1000 : null;
  }
  async function rafraichirEtat(initial, silencieux) {
    const generation = etat.generation;
    try {
      const publique = await etat.api.etat();
      if (generation !== etat.generation) return true;  // un booster a été ouvert pendant la requête : cette réponse est déjà périmée
      etat.public = publique;
      etat.panne = false;
      synchroniserOfferts();
      return true;
    } catch (e) {
      etat.panne = true;
      if (initial) $('sous-titre').textContent = `Serveur injoignable — ${e.message}`;
      if (!silencieux) notifier(e.message);
      return false;
    }
  }

  /* ====================================================================
     Rendu général
     ==================================================================== */
  function rendreTout(doux) {
    rendreSousTitre();
    rendreCompte();
    rendreBoosters(doux);
    mettreAJourAlbum();
    rendreJoueurs();
    rendreFil();
    rendreTableRaretes();
    rendrePronos();
  }
  function rendreSousTitre() {
    if (etat.panne && !etat.public) return;
    const nbMythiques = (etat.parRarete.get('mythique') || []).length;
    const total = etat.catalogue.cartes.length - nbMythiques;
    const offerts = reglageOfferts();
    $('sous-titre').textContent = `${total} cartes, une par couple pilote–écurie depuis ${etat.catalogue.premiereSaison || 2000}${nbMythiques ? `, plus les ${nbMythiques} cartes Mythiques de la bande` : ''}. ${texteRatio()} de ${etat.catalogue.cartesParBooster} cartes.`
      + (offerts ? ` En plus : 1 booster offert ${texteRythme(offerts.intervalle)} (${offerts.max} en stock au maximum).` : '');
    document.querySelectorAll('.ratio-boosters').forEach((n) => { n.textContent = texteRatio(); });
    document.querySelectorAll('.aide-offerts').forEach((n) => {
      n.hidden = !offerts;
      if (!offerts) return;
      n.textContent = n.dataset.forme === 'courte'
        ? ` Boosters offerts : 1 ${texteRythme(offerts.intervalle)}, ${offerts.max} en stock au maximum.`
        : ` Chaque joueur reçoit aussi 1 booster offert ${texteRythme(offerts.intervalle)}, mis en stock jusqu’à ${offerts.max} : quand le stock est plein, le compteur s’arrête jusqu’à la prochaine ouverture. Les boosters offerts s’ouvrent en premier.`;
    });
  }
  function rendreCompte() {
    const zone = $('compte');
    zone.textContent = '';
    if (!etat.session) {
      zone.appendChild(el('span', 'texte', 'Les collections sont visibles par tous ; connectez-vous pour ouvrir vos boosters.'));
      const b = el('button', 'bouton', 'Se connecter', { type: 'button' });
      b.addEventListener('click', ouvrirConnexion);
      zone.appendChild(b);
      return;
    }
    const moi = joueurConnecte();
    const puces = el('div', 'puces');
    const pj = el('span', 'puce');
    const past = el('span', 'pastille');
    past.style.background = moi ? couleurJoueur(moi) : '#888';
    pj.append(past, el('b', null, etat.session.nom));
    puces.appendChild(pj);
    if (moi) {
      const pb = el('span', 'puce'); pb.append(el('b', null, String(moi.boostersDispo)), el('span', null, moi.boostersDispo > 1 ? ' boosters à ouvrir' : ' booster à ouvrir')); puces.appendChild(pb);
      const pf = el('span', 'puce'); pf.append(el('b', null, String(moi.fragments)), el('span', null, moi.fragments > 1 ? ' fragments' : ' fragment')); puces.appendChild(pf);
    } else {
      puces.appendChild(el('span', 'puce', etat.panne ? 'Serveur injoignable' : 'Joueur inconnu du serveur'));
    }
    zone.appendChild(puces);
    const b = el('button', 'bouton secondaire petit', 'Déconnexion', { type: 'button' });
    b.addEventListener('click', deconnecter);
    zone.appendChild(b);
  }

  /* ---------- Connexion ---------- */
  function ouvrirConnexion() {
    const select = $('connexion-nom');
    select.textContent = '';
    const joueurs = etat.public ? etat.public.joueurs : JOUEURS_DEMO.map((j) => ({ id: j.id, nom: j.nom, compte: true }));
    joueurs.forEach((j) => select.appendChild(el('option', null, j.nom, { value: j.id })));
    const dernier = stockage.lire(CLE_DERNIER_NOM);
    if (dernier && joueurs.some((j) => j.id === dernier)) select.value = dernier;
    $('connexion-mdp').value = '';
    $('connexion-erreur').hidden = true;
    $('connexion-valider').disabled = false;
    majAideConnexion();
    $('modale-connexion').hidden = false;
    select.focus();
  }
  function majAideConnexion() {
    const id = $('connexion-nom').value;
    const j = etat.public ? etat.public.joueurs.find((x) => x.id === id) : null;
    $('connexion-aide').textContent = j && !j.compte
      ? `${j.nom} n’a pas encore de mot de passe : celui que vous saisissez maintenant sera enregistré (4 caractères minimum). Retenez-le bien !`
      : 'Première connexion ? Le mot de passe que vous saisissez devient le vôtre (4 caractères minimum) : retenez-le bien.';
  }
  function fermerConnexion() { $('modale-connexion').hidden = true; }
  function initialiserConnexion() {
    $('connexion-nom').addEventListener('change', majAideConnexion);
    $('connexion-annuler').addEventListener('click', fermerConnexion);
    $('modale-connexion').addEventListener('click', (e) => { if (e.target === $('modale-connexion')) fermerConnexion(); });
    $('form-connexion').addEventListener('submit', async (e) => {
      e.preventDefault();
      const select = $('connexion-nom');
      const nom = select.options[select.selectedIndex] ? select.options[select.selectedIndex].textContent : '';
      const mdp = $('connexion-mdp').value;
      const erreur = $('connexion-erreur');
      if (!nom) { erreur.textContent = 'Choisissez votre prénom.'; erreur.hidden = false; return; }
      if (mdp.length < 4) { erreur.textContent = 'Le mot de passe doit faire au moins 4 caractères.'; erreur.hidden = false; return; }
      $('connexion-valider').disabled = true;
      erreur.hidden = true;
      try {
        const r = await etat.api.connexion(nom, mdp);
        etat.session = { jeton: r.jeton, joueur: r.joueur, nom: r.nom || nom };
        stockage.ecrire(CLE_SESSION, etat.session);
        stockage.ecrire(CLE_DERNIER_NOM, r.joueur);
        etat.albumJoueur = r.joueur;
        fermerConnexion();
        notifier(r.premiereConnexion ? `Bienvenue ${etat.session.nom} ! Votre mot de passe est enregistré.` : `Bonjour ${etat.session.nom} !`, 'succes');
        await rafraichirEtat();
        rendreTout();
        if (location.hash !== '#boosters' && location.hash !== '#pronostics') location.hash = '#boosters';
      } catch (err) {
        erreur.textContent = err.message || 'Connexion impossible.';
        erreur.hidden = false;
      } finally {
        $('connexion-valider').disabled = false;
      }
    });
  }
  async function deconnecter() {
    const jeton = etat.session && etat.session.jeton;
    effacerSession();
    rendreTout();
    notifier('Vous êtes déconnecté.');
    if (jeton) { try { await etat.api.deconnexion(jeton); } catch (e) { /* sans importance */ } }
  }

  /* ====================================================================
     Boosters
     ==================================================================== */
  function rendreBoosters(doux) {
    const moi = joueurConnecte();
    $('boosters-hors-ligne').hidden = !!etat.session;
    $('boosters-zone').hidden = !etat.session;
    const compteur = $('boosters-compteur');
    compteur.textContent = '';
    const b1 = $('btn-ouvrir-1'), b10 = $('btn-ouvrir-10'), bt = $('btn-ouvrir-tout');
    if (!moi) {
      if (etat.session) compteur.appendChild(el('span', 'puce', etat.panne ? 'Serveur injoignable' : 'Données indisponibles'));
      b1.disabled = b10.disabled = bt.disabled = true;
      if ($('offerts')) $('offerts').hidden = true;
      return;
    }
    const dispo = moi.boostersDispo;
    const offerts = offertsDe(moi);
    [[String(dispo), dispo > 1 ? ' boosters à ouvrir' : ' booster à ouvrir'], [`${moi.boostersOuverts} / ${moi.boostersGagnes}`, offerts ? ' ouverts (hors offerts)' : ' ouverts'], [String(moi.fragments), moi.fragments > 1 ? ' fragments' : ' fragment']]
      .forEach(([val, lib]) => { const p = el('span', 'puce'); p.append(el('b', null, val), el('span', null, lib)); compteur.appendChild(p); });
    if (moi.boostersPronos > 0) {
      const pp = el('span', 'puce'); pp.append(el('b', null, String(moi.boostersPronos)), el('span', null, ` gagné${moi.boostersPronos > 1 ? 's' : ''} aux pronostics`)); compteur.appendChild(pp);
    }
    b1.disabled = etat.occupe || dispo < 1;
    b10.disabled = etat.occupe || dispo < 10;
    bt.disabled = etat.occupe || dispo < 2;
    bt.textContent = dispo > 1 ? `Tout ouvrir (${dispo})` : 'Tout ouvrir';
    rendreOfferts();
    if (!etat.occupe) {
      // « doux » (rafraîchissement automatique) : on ne remplace pas le message affiché pendant qu'on regarde les cartes tirées
      if (!(doux && (!$('recap').hidden || !$('main-cartes').hidden))) {
        $('indication').textContent = dispo
          ? `${pluriel(dispo, 'booster')} à ouvrir.`
          : (reglageOfferts() ? 'Plus de booster pour le moment : attendez le prochain booster offert ou marquez des points au championnat !'
            : 'Plus de booster pour le moment : marquez des points au championnat !');
      }
      if (!dispo) $('paquet').hidden = true;
      else if ($('main-cartes').hidden && $('recap').hidden) $('paquet').hidden = false;
    }
  }

  /* ---------- Boosters offerts : stock, barre de progression et compte à rebours ---------- */
  function rendreOfferts() {
    const bloc = $('offerts');
    if (!bloc) return;  // ancienne page HTML encore en cache avec le nouveau script
    const o = offertsDe(joueurConnecte());
    bloc.hidden = !o;
    if (!o) return;
    $('offerts-stock').textContent = `${o.stock} / ${o.max}`;
    bloc.classList.toggle('plein', o.intervalle > 0 && o.stock >= o.max);
    majCompteARebours();
  }
  function majCompteARebours() {
    const o = offertsDe(joueurConnecte());
    if (!o || !$('offerts') || $('offerts').hidden) return;
    const texte = $('offerts-texte'), barre = $('offerts-progres');
    if (o.intervalle <= 0) {
      texte.textContent = 'Système désactivé : seul le stock restant peut encore être ouvert.';
      barre.style.width = '0%';
    } else if (etat.offertsFin === null) {
      texte.textContent = 'Stock plein : ouvrez un booster offert pour relancer le compteur.';
      barre.style.width = '100%';
    } else {
      const reste = Math.max(0, (etat.offertsFin - Date.now()) / 1000);
      texte.textContent = reste > 0 ? `Prochain booster offert dans ${dureeCourte(reste)}` : 'Un nouveau booster offert arrive…';
      barre.style.width = `${Math.min(100, Math.max(0, 100 * (1 - reste / o.intervalle))).toFixed(1)}%`;
      if (reste <= 0) rafraichirOfferts();
    }
  }
  /* Appelé quand le compte à rebours arrive à zéro, ou quand l'onglet redevient visible. Au plus une fois toutes les 10 s
     (l'attente double jusqu'à 2 min tant que le serveur ne répond pas), et jamais pendant l'ouverture d'un booster. */
  async function rafraichirOfferts() {
    if (!etat.session || etat.occupe || etat.rafraichitOfferts || Date.now() < etat.prochainEssaiOfferts) return;
    etat.rafraichitOfferts = true;
    etat.prochainEssaiOfferts = Date.now() + etat.pauseOfferts;
    const avant = (offertsDe(joueurConnecte()) || {}).stock;
    try {
      const ok = await rafraichirEtat(false, true);
      etat.pauseOfferts = ok ? 10000 : Math.min(etat.pauseOfferts * 2, 120000);
      etat.prochainEssaiOfferts = Date.now() + etat.pauseOfferts;
      if (ok && !etat.occupe) {
        rendreTout(true);
        const apres = (offertsDe(joueurConnecte()) || {}).stock;
        if (typeof avant === 'number' && typeof apres === 'number' && apres > avant) {
          notifier(apres - avant > 1 ? `${apres - avant} boosters offerts sont arrivés !` : 'Un booster offert est arrivé !', 'succes');
        }
      }
    } finally {
      etat.rafraichitOfferts = false;
    }
  }

  function contenuPaquet() {
    const c = el('div', 'contenu');
    appliquerCouleurs(c, ['#1f1f2b', '#e10600', '#ffffff']);
    c.appendChild(el('span', 'sous', 'Championnat F1 25'));
    c.appendChild(casqueSvg());
    c.appendChild(el('span', 'titre', 'Booster'));
    c.appendChild(el('span', 'sous', `${etat.catalogue ? etat.catalogue.cartesParBooster : 5} cartes pilotes`));
    c.appendChild(el('span', 'pastille-paquet', 'Peu commune garantie'));
    return c;
  }
  function polygone(pts) { return 'polygon(' + pts.map((p) => `${p[0].toFixed(2)}% ${p[1].toFixed(2)}%`).join(', ') + ')'; }
  function dents(n, yPlein, yCreux, inverse) {
    const pts = [];
    for (let i = 0; i <= n; i++) pts.push([(i / n) * 100, i % 2 ? yCreux : yPlein]);
    return inverse ? pts.reverse() : pts;
  }
  function pointsDechirure() {
    const pts = [], n = 16;
    for (let i = 0; i <= n; i++) pts.push([(i / n) * 100, 23 + (i % 2 ? 2.4 : -2.4) + (i === 0 || i === n ? 0 : (Math.random() - 0.5) * 2)]);
    return pts;
  }
  function preparerPaquet() {
    const haut = $('paquet-haut'), bas = $('paquet-bas');
    haut.textContent = ''; bas.textContent = '';
    haut.appendChild(contenuPaquet()); bas.appendChild(contenuPaquet());
    const dechirure = pointsDechirure();
    haut.style.clipPath = polygone(dents(20, 0, 2.2, false).concat(dechirure.slice().reverse()));
    bas.style.clipPath = polygone(dechirure.concat(dents(20, 100, 97.8, true)));
  }

  function appliquerResultat(reponse, nbOuverts) {
    etat.generation++;
    const moi = joueurConnecte();
    if (!moi) return;
    const possedees = new Set(moi.cartes);
    (reponse.boosters || []).forEach((b) => b.forEach((t) => {
      if (t.nouvelle && !possedees.has(t.carte) && etat.cartes.has(t.carte)) { possedees.add(t.carte); moi.cartes.push(t.carte); etat.nouvellesRecentes.add(t.carte); }
    }));
    moi.nbCartes = moi.cartes.length;
    if (typeof reponse.fragments === 'number') moi.fragments = reponse.fragments;
    if (typeof reponse.boostersDispo === 'number') moi.boostersDispo = reponse.boostersDispo;
    // Les boosters offerts ne comptent pas dans « ouverts » : le serveur renvoie le vrai total (ancien serveur : tout vient des points)
    if (typeof reponse.boostersOuverts === 'number') moi.boostersOuverts = reponse.boostersOuverts;
    else moi.boostersOuverts += nbOuverts;
    moi.offerts = reponse.offerts || null;
    synchroniserOfferts();
    rendreCompte();
    mettreAJourAlbum();
  }

  function couleursParticules(rarete) {
    if (rarete === 'mythique') return PARTICULES_MYTHIQUE;
    return rarete === 'icone' ? PARTICULES_ICONE : [COULEURS_RARETE[rarete] || '#fff', '#ffffff'];
  }
  function particules(conteneur, n, couleurs) {
    if (reduitMouvement) return;
    for (let i = 0; i < n; i++) {
      const p = el('i', 'particule');
      p.style.setProperty('--a', `${(Math.random() * 360).toFixed(1)}deg`);
      p.style.setProperty('--d', `${(70 + Math.random() * 130).toFixed(0)}px`);
      p.style.setProperty('--t', `${(Math.random() * 220).toFixed(0)}ms`);
      p.style.setProperty('--s', `${(3 + Math.random() * 5).toFixed(1)}px`);
      p.style.setProperty('--pc', couleurs[i % couleurs.length]);
      conteneur.appendChild(p);
    }
    setTimeout(() => { conteneur.querySelectorAll('.particule').forEach((x) => x.remove()); }, 1700);
  }

  function creerPioche(t, i) {
    const c = t.carte;
    const p = el('div', `pioche format r-${c.rarete}`);
    p.style.setProperty('--i', i);
    p.style.setProperty('--rang', rangDe(c.rarete));
    const flip = el('div', 'flip');
    const dosFace = el('div', 'flip-dos remplit');
    const dosFormat = el('div', 'format');
    dosFormat.appendChild(creerDos());
    dosFace.appendChild(dosFormat);
    const avant = el('div', 'flip-face remplit');
    avant.appendChild(creerCarte(c));
    flip.append(dosFace, avant);
    p.appendChild(flip);
    p.appendChild(el('span', 'etiquette' + (t.nouvelle ? ' nouvelle' : ''), t.nouvelle ? 'Nouvelle !' : `Doublon · +${t.fragments} fragment${t.fragments > 1 ? 's' : ''}`));
    p._tirage = t;
    p.addEventListener('click', () => { if (p.classList.contains('revele')) ouvrirLoupe(c, joueurConnecte()); else revelerSuivante(); });
    return p;
  }
  function revelerSuivante() {
    if (!etat.occupe) return;
    const suivante = etat.pioches.find((p) => !p.classList.contains('revele'));
    if (!suivante) return;
    const t = suivante._tirage, c = t.carte, rang = rangDe(c.rarete);
    suivante.classList.add('revele');
    if (rang >= rangDe('rare')) {
      const flash = el('i', 'eclair');
      suivante.appendChild(flash);
      setTimeout(() => flash.remove(), 900);
    }
    particules(suivante, NB_PARTICULES[c.rarete] || 0, couleursParticules(c.rarete));
    if (rang >= rangDe('legendaire')) {
      const scene = $('scene');
      scene.style.setProperty('--rc', c.rarete === 'mythique' ? '#e10600' : (c.rarete === 'icone' ? '#ffffff' : '#e8b923'));
      scene.classList.remove('flash-scene');
      void scene.offsetWidth;
      scene.classList.add('flash-scene');
      if (c.rarete === 'mythique') {  // la grande scène : la table tremble, flash rouge, et une annonce
        scene.classList.remove('secousse');
        void scene.offsetWidth;
        scene.classList.add('secousse');
        setTimeout(() => scene.classList.remove('secousse'), 900);
        notifier(t.nouvelle ? `Carte Mythique ! ${c.prenom} « ${c.nom} » rejoint votre collection.` : `Carte Mythique en double : ${c.prenom} « ${c.nom} » (+${pluriel(t.fragments, 'fragment')}).`, 'succes');
      }
    }
    const restantes = etat.pioches.filter((p) => !p.classList.contains('revele')).length;
    const detail = t.nouvelle ? 'nouvelle carte' : `doublon, +${pluriel(t.fragments, 'fragment')}`;
    $('indication').textContent = `${c.prenom} ${c.nom} (${nomEcurie(c.ecurie)}) — ${rareteDe(c.rarete).nom}, ${detail}${restantes ? ` · encore ${pluriel(restantes, 'carte')}` : ''}`;
    if (restantes === 0) {
      clearTimeout(etat.minuterie);
      etat.occupe = false;
      $('btn-tout-reveler').hidden = true;
      rendreBoosters();
      $('indication').textContent = `${c.prenom} ${c.nom} (${nomEcurie(c.ecurie)}) — ${rareteDe(c.rarete).nom}, ${detail}. Booster terminé !`;
      rafraichirEtat().then((ok) => { if (ok && !etat.occupe) { rendreJoueurs(); rendreFil(); rendreCompte(); rendreBoosters(true); } });
    } else {
      planifierAuto();
    }
  }
  function planifierAuto() {
    clearTimeout(etat.minuterie);
    etat.minuterie = setTimeout(revelerSuivante, delai(1500));
  }
  function toutReveler() {
    clearTimeout(etat.minuterie);
    (function boucle() {
      if (!etat.occupe) return;
      revelerSuivante();
      clearTimeout(etat.minuterie);
      if (etat.occupe) etat.minuterie = setTimeout(boucle, delai(500));
    })();
  }

  async function ouvrirUn() {
    if (etat.occupe) return;
    const moi = joueurConnecte();
    if (!moi) { ouvrirConnexion(); return; }
    etat.occupe = true;
    rendreBoosters();
    $('indication').textContent = 'Ouverture du booster…';
    let reponse;
    try { reponse = await etat.api.ouvrir(etat.session.jeton, 1); }
    catch (e) { etat.occupe = false; rendreBoosters(); gererErreur(e); return; }
    const tirage = (reponse.boosters && reponse.boosters[0]) || [];
    appliquerResultat(reponse, reponse.boosters ? reponse.boosters.length : 1);
    const paquet = $('paquet'), main = $('main-cartes');
    $('recap').hidden = true;
    const mainVisible = !main.hidden;
    main.hidden = true; main.textContent = ''; etat.pioches = [];
    $('paquet-multiple').hidden = true;
    preparerPaquet();
    paquet.classList.remove('ouvert', 'secoue', 'rafale');
    if (paquet.hidden || mainVisible) { paquet.hidden = false; paquet.classList.add('reapparait'); await dormir(delai(500)); }
    paquet.classList.remove('reapparait');
    paquet.classList.add('secoue');
    await dormir(delai(450));
    paquet.classList.remove('secoue');
    paquet.classList.add('ouvert');
    await dormir(delai(1050));
    paquet.hidden = true;
    paquet.classList.remove('ouvert');
    const trie = tirage.map((t) => ({ carte: etat.cartes.get(t.carte), nouvelle: !!t.nouvelle, fragments: t.fragments || 0 }))
      .filter((t) => t.carte)
      .sort((a, b) => rangDe(a.carte.rarete) - rangDe(b.carte.rarete));
    etat.pioches = trie.map((t, i) => { const p = creerPioche(t, i); main.appendChild(p); return p; });
    main.hidden = false;
    if (!trie.length) { etat.occupe = false; rendreBoosters(); notifier('Le serveur n’a renvoyé aucune carte.'); return; }
    $('btn-tout-reveler').hidden = false;
    $('indication').textContent = 'Cliquez une carte pour la retourner (ou laissez faire).';
    planifierAuto();
  }

  async function ouvrirPlusieurs(nombre) {
    if (etat.occupe) return;
    const moi = joueurConnecte();
    if (!moi) { ouvrirConnexion(); return; }
    let restant = Math.min(nombre, moi.boostersDispo);
    if (restant <= 0) return;
    const demande = restant;
    etat.occupe = true;
    rendreBoosters();
    $('indication').textContent = `Ouverture de ${pluriel(demande, 'booster')}…`;
    let boosters = [];
    try {
      while (restant > 0) {
        const reponse = await etat.api.ouvrir(etat.session.jeton, Math.min(100, restant));
        const lot = reponse.boosters || [];
        if (!lot.length) break;
        boosters = boosters.concat(lot);
        appliquerResultat(reponse, lot.length);
        restant -= lot.length;
      }
    } catch (e) {
      if (!boosters.length) { etat.occupe = false; rendreBoosters(); gererErreur(e); return; }
      notifier(e.message);
    }
    const paquet = $('paquet'), main = $('main-cartes');
    main.hidden = true; main.textContent = ''; etat.pioches = [];
    $('recap').hidden = true;
    preparerPaquet();
    const badge = $('paquet-multiple');
    badge.textContent = `×${boosters.length}`;
    badge.hidden = false;
    paquet.classList.remove('ouvert', 'secoue', 'rafale', 'reapparait');
    paquet.hidden = false;
    void paquet.offsetWidth;
    paquet.classList.add('rafale');
    await dormir(delai(900));
    paquet.classList.remove('rafale');
    paquet.classList.add('ouvert');
    await dormir(delai(900));
    paquet.hidden = true;
    paquet.classList.remove('ouvert');
    badge.hidden = true;
    rendreRecap(boosters);
    etat.occupe = false;
    rendreBoosters();
    $('indication').textContent = `${pluriel(boosters.length, 'booster')} ouvert${boosters.length > 1 ? 's' : ''} : voici le récapitulatif.`;
    rafraichirEtat().then((ok) => { if (ok && !etat.occupe) { rendreJoueurs(); rendreFil(); rendreCompte(); rendreBoosters(true); } });
  }

  function rendreRecap(boosters) {
    const recap = $('recap');
    recap.textContent = '';
    const nouvelles = [], doublons = {};
    let nbDoublons = 0, fragmentsGagnes = 0, nbCartes = 0;
    boosters.forEach((b) => b.forEach((t) => {
      const c = etat.cartes.get(t.carte);
      if (!c) return;
      nbCartes++;
      if (t.nouvelle) nouvelles.push(c);
      else { nbDoublons++; fragmentsGagnes += t.fragments || 0; doublons[c.rarete] = (doublons[c.rarete] || 0) + 1; }
    }));
    nouvelles.sort((a, b) => rangDe(b.rarete) - rangDe(a.rarete) || a.numero - b.numero);

    const tete = el('div', 'recap-tete');
    const puces = el('div', 'puces');
    [[boosters.length, 'booster'], [nbCartes, 'carte'], [nouvelles.length, 'nouvelle carte', 'nouvelles cartes'], [nbDoublons, 'doublon']]
      .forEach(([n, s, p]) => { const puce = el('span', 'puce'); puce.append(el('b', null, String(n)), el('span', null, ' ' + (n > 1 ? (p || s + 's') : s))); puces.appendChild(puce); });
    const pf = el('span', 'puce');
    pf.append(el('b', null, `+${fragmentsGagnes}`), el('span', null, ' fragments'));
    puces.appendChild(pf);
    tete.appendChild(puces);
    const fermer = el('button', 'bouton secondaire petit', 'Fermer le récapitulatif', { type: 'button' });
    fermer.addEventListener('click', () => { recap.hidden = true; rendreBoosters(); if (!$('paquet').hidden) $('paquet').classList.add('reapparait'); });
    tete.appendChild(fermer);
    recap.appendChild(tete);

    const grandes = nouvelles.filter((c) => rangDe(c.rarete) >= rangDe('epique')).slice(0, 8);
    if (grandes.length) {
      recap.appendChild(el('h3', null, 'Meilleures nouvelles cartes'));
      const zone = el('div', 'recap-grandes');
      grandes.forEach((c) => zone.appendChild(creerCarte(c, { cliquable: true, paresseux: true })));
      recap.appendChild(zone);
    }
    recap.appendChild(el('h3', null, nouvelles.length ? `Nouvelles cartes (${nouvelles.length}), de la plus rare à la plus courante` : 'Aucune nouvelle carte cette fois'));
    if (nouvelles.length) {
      const minis = el('div', 'minis');
      nouvelles.forEach((c) => {
        const m = creerMini(c);
        marquerTuile(m, c, true);
        m.addEventListener('click', () => ouvrirLoupe(c, joueurConnecte()));
        minis.appendChild(m);
      });
      recap.appendChild(minis);
    }
    if (nbDoublons) {
      const parts = etat.catalogue.raretes.filter((r) => doublons[r.id]).map((r) => `${doublons[r.id]} ${r.nom.toLowerCase()}${doublons[r.id] > 1 ? 's' : ''}`);
      recap.appendChild(el('p', 'recap-doublons', `Doublons recyclés : ${parts.join(', ')} → +${pluriel(fragmentsGagnes, 'fragment')}.`));
    }
    recap.hidden = false;
  }

  function rendreTableRaretes() {
    const table = $('table-raretes');
    table.textContent = '';
    const thead = el('thead'), trh = el('tr');
    ['Rareté', 'Règle (dans cette écurie)', 'Cartes', 'Chance par carte', 'Doublon', 'Fabrication'].forEach((t, i) => trh.appendChild(el('th', i >= 2 ? 'num' : null, t)));
    thead.appendChild(trh);
    table.appendChild(thead);
    const tbody = el('tbody');
    etat.catalogue.raretes.forEach((r) => {
      const tr = el('tr', `r-${r.id}`);
      const td = el('td');
      td.append(gemmes(r.id), el('span', 'rarete-nom', r.nom));
      tr.appendChild(td);
      tr.appendChild(el('td', null, r.regle));
      tr.appendChild(el('td', 'num', String((etat.parRarete.get(r.id) || []).length)));
      const mythique = r.id === 'mythique';  // tirage à part, uniquement dans les boosters
      tr.appendChild(el('td', 'num', mythique ? (mythiquesActives() ? `≈ ${formaterNombre(chanceMythique())} % par booster` : 'Bientôt (mise à jour du serveur)') : `${r.poids} %`));
      tr.appendChild(el('td', 'num', `+${pluriel(r.fragments, 'fragment')}`));
      tr.appendChild(el('td', 'num', mythique ? 'Impossible' : pluriel(r.cout, 'fragment')));
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
  }

  function initialiserBoosters() {
    $('btn-ouvrir-1').addEventListener('click', ouvrirUn);
    $('btn-ouvrir-10').addEventListener('click', () => ouvrirPlusieurs(10));
    $('btn-ouvrir-tout').addEventListener('click', () => { const moi = joueurConnecte(); if (moi) ouvrirPlusieurs(moi.boostersDispo); });
    $('btn-tout-reveler').addEventListener('click', toutReveler);
  }

  /* ====================================================================
     Album
     ==================================================================== */
  function construireAlbum() {
    const album = $('album');
    album.textContent = '';
    etat.tuiles.clear();
    etat.groupes.clear();
    etat.catalogue.raretes.forEach((r) => {
      const liste = (etat.parRarete.get(r.id) || []).slice().sort((a, b) => a.numero - b.numero);
      const entete = el('div', `groupe r-${r.id}`);
      const compte = el('small', null, '');
      entete.append(gemmes(r.id), el('span', null, r.nom), compte);
      album.appendChild(entete);
      etat.groupes.set(r.id, { entete, compte, total: liste.length });
      liste.forEach((c) => { const m = creerMini(c); etat.tuiles.set(c.id, m); album.appendChild(m); });
    });
    etat.albumConstruit = true;
  }
  function mettreAJourAlbum() {
    if (!etat.albumConstruit) construireAlbum();
    const j = joueurAlbum();
    const possedees = new Set(j ? j.cartes : []);
    const estMoi = !!(j && etat.session && j.id === etat.session.joueur);
    $('album-titre').textContent = j ? (estMoi ? 'Ma collection' : `Collection de ${j.nom}`) : 'Collection';
    const lecture = $('album-lecture');
    lecture.hidden = !(j && !estMoi);
    if (j && !estMoi) {
      $('album-lecture-texte').textContent = `Album de ${j.nom} — lecture seule`;
      lecture.style.setProperty('--couleur', couleurJoueur(j));
    }
    $('btn-mon-album').hidden = !etat.session;
    $('album-aide').textContent = j
      ? (estMoi ? 'Cliquez sur une carte possédée pour l’admirer, sur une carte manquante pour voir son coût et la fabriquer avec vos fragments.'
        : `Les cartes de ${j.nom}. Connectez-vous pour gérer votre propre album.`)
      : 'Connectez-vous pour voir votre collection, ou choisissez un joueur dans l’onglet Collections.';
    const comptes = {};
    etat.catalogue.raretes.forEach((r) => { comptes[r.id] = 0; });
    etat.tuiles.forEach((m, id) => {
      const c = etat.cartes.get(id);
      const p = possedees.has(id);
      marquerTuile(m, c, p);
      m.classList.toggle('nouvelle-carte', p && estMoi && etat.nouvellesRecentes.has(id));
      if (p) comptes[c.rarete] = (comptes[c.rarete] || 0) + 1;
    });
    etat.groupes.forEach((g, id) => { g.compte.textContent = `${comptes[id] || 0} / ${g.total}`; });
    const total = etat.catalogue.cartes.length, n = possedees.size;
    $('prog-texte').textContent = `${n} / ${total}`;
    $('prog-pct').textContent = `${Math.round((n / total) * 100)} %`;
    requestAnimationFrame(() => { $('prog-barre').style.width = `${(n / total) * 100}%`; });
    const resume = $('resume');
    resume.textContent = '';
    etat.catalogue.raretes.forEach((r) => {
      const s = el('span', `r-${r.id}`);
      s.append(gemmes(r.id), el('span', null, r.nom), el('b', null, `${comptes[r.id] || 0}/${etat.groupes.get(r.id).total}`));
      resume.appendChild(s);
    });
    appliquerFiltres();
  }
  function appliquerFiltres() {
    const f = etat.filtres, recherche = normaliser(f.recherche).trim();
    const visiblesParGroupe = {};
    let visibles = 0;
    etat.tuiles.forEach((m, id) => {
      const c = etat.cartes.get(id);
      const possede = m.classList.contains('possede');
      let ok = !(f.rarete && c.rarete !== f.rarete) && !(f.ecurie && c.ecurie !== f.ecurie);
      if (ok && f.possession === 'possedees' && !possede) ok = false;
      if (ok && f.possession === 'manquantes' && possede) ok = false;
      if (ok && recherche && !c.cle.includes(recherche)) ok = false;
      m.hidden = !ok;
      if (ok) { visibles++; visiblesParGroupe[c.rarete] = (visiblesParGroupe[c.rarete] || 0) + 1; }
    });
    etat.groupes.forEach((g, id) => { g.entete.hidden = !visiblesParGroupe[id]; });
    $('filtres-compte').textContent = `${pluriel(visibles, 'carte')} affichée${visibles > 1 ? 's' : ''}`;
    $('album-vide').hidden = visibles > 0;
  }
  function remplirFiltres() {
    const sr = $('filtre-rarete');
    etat.catalogue.raretes.forEach((r) => sr.appendChild(el('option', null, r.nom, { value: r.id })));
    const se = $('filtre-ecurie');
    Object.keys(etat.catalogue.ecuries)
      .map((id) => ({ id, nom: nomEcurie(id) }))
      .sort((a, b) => a.nom.localeCompare(b.nom, 'fr'))
      .forEach((e) => se.appendChild(el('option', null, e.nom, { value: e.id })));
  }
  function initialiserFiltres() {
    $('filtre-recherche').addEventListener('input', (e) => { etat.filtres.recherche = e.target.value; appliquerFiltres(); });
    $('filtre-rarete').addEventListener('change', (e) => { etat.filtres.rarete = e.target.value; appliquerFiltres(); });
    $('filtre-ecurie').addEventListener('change', (e) => { etat.filtres.ecurie = e.target.value; appliquerFiltres(); });
    $('filtre-possession').addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      etat.filtres.possession = b.dataset.valeur;
      Array.from($('filtre-possession').children).forEach((x) => x.setAttribute('aria-pressed', x === b ? 'true' : 'false'));
      appliquerFiltres();
    });
    $('btn-mon-album').addEventListener('click', () => { etat.albumJoueur = etat.session ? etat.session.joueur : null; mettreAJourAlbum(); });
    $('album').addEventListener('click', (e) => {
      const m = e.target.closest('.mini');
      if (!m) return;
      const c = etat.cartes.get(m.dataset.id);
      if (c) ouvrirLoupe(c, joueurAlbum());
    });
  }

  /* ====================================================================
     Loupe et fabrication
     ==================================================================== */
  function ouvrirLoupe(c, joueur) {
    const j = joueur || joueurAlbum();
    const moi = joueurConnecte();
    const possede = !!(j && j.cartes.includes(c.id));
    const estMoi = !!(j && moi && j.id === moi.id);
    const r = rareteDe(c.rarete);
    const zone = $('loupe-carte');
    zone.textContent = '';
    zone.appendChild(creerCarte(c, { manquante: !possede }));
    const infos = $('loupe-infos');
    infos.textContent = '';
    const l1 = el('p', 'ligne');
    l1.append(el('b', null, `${c.prenom} ${c.nom}`), el('span', null, ` · ${nomEcurie(c.ecurie)} · ${c.saisons || ''}`));
    infos.appendChild(l1);
    const l2 = el('p', `ligne r-${c.rarete}`);
    l2.append(el('span', null, `N° ${pad3(c.numero)}/${etat.catalogue.cartes.length} · `), gemmes(c.rarete), el('span', null, ' '), el('span', 'rarete-nom', r.nom), el('span', null, ` · ${r.regle}`));
    infos.appendChild(l2);
    if (!possede && c.rarete === 'mythique') {
      infos.appendChild(el('p', 'cout', 'Carte manquante · elle ne se fabrique pas'));
      infos.appendChild(el('p', 'ligne', mythiquesActives()
        ? `Une Mythique se trouve uniquement dans les boosters : environ ${formaterNombre(chanceMythique())} % de chance par booster, et tant qu’il vous en manque, c’est une nouvelle qui sort en premier.`
        : 'Une Mythique se trouvera uniquement dans les boosters : elles arrivent dès que le serveur du jeu sera mis à jour.'));
    } else if (!possede) {
      const cout = c.cout ?? r.cout;
      infos.appendChild(el('p', 'cout', `Carte manquante · fabrication : ${pluriel(cout, 'fragment')}`));
      if (!etat.session) infos.appendChild(el('p', 'ligne', 'Connectez-vous pour fabriquer cette carte avec vos fragments.'));
      else if (!j || !estMoi) infos.appendChild(el('p', 'ligne', j ? `Vous consultez l’album de ${j.nom}.` : ''));
      else {
        const assez = moi.fragments >= cout;
        if (!assez) infos.appendChild(el('p', 'ligne', `Vous avez ${pluriel(moi.fragments, 'fragment')} : il en manque ${cout - moi.fragments}.`));
        const b = el('button', 'bouton', assez ? `Fabriquer (${moi.fragments} fragments disponibles)` : 'Fabriquer', { type: 'button' });
        b.disabled = !assez;
        b.addEventListener('click', () => fabriquer(c, b));
        infos.appendChild(b);
      }
    } else if (j) {
      infos.appendChild(el('p', 'ligne', estMoi ? 'Dans votre collection.' : `Dans la collection de ${j.nom}.`));
    }
    const photo = photoDe(c);
    if (photo) infos.appendChild(ligneCredit(photo, 'credit'));
    $('loupe').hidden = false;
  }
  function fermerLoupe() { $('loupe').hidden = true; }
  function initialiserLoupe() {
    $('loupe-fermer').addEventListener('click', fermerLoupe);
    $('loupe').addEventListener('click', (e) => { if (e.target === $('loupe')) fermerLoupe(); });
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      if (!$('loupe').hidden) fermerLoupe();
      else if (!$('modale-connexion').hidden) fermerConnexion();
    });
  }
  async function fabriquer(c, bouton) {
    if (!etat.session) return;
    bouton.disabled = true;
    bouton.textContent = 'Fabrication…';
    try {
      const r = await etat.api.fabriquer(etat.session.jeton, c.id);
      const moi = joueurConnecte();
      if (moi) {
        if (!moi.cartes.includes(c.id)) moi.cartes.push(c.id);
        moi.nbCartes = moi.cartes.length;
        if (typeof r.fragments === 'number') moi.fragments = r.fragments;
      }
      etat.nouvellesRecentes.add(c.id);
      notifier(`${c.prenom} ${c.nom} (${nomEcurie(c.ecurie)}) fabriquée ! Il vous reste ${pluriel(r.fragments, 'fragment')}.`, 'succes');
      rendreCompte();
      rendreBoosters();
      mettreAJourAlbum();
      ouvrirLoupe(c, moi);
      $('loupe-infos').insertBefore(el('p', 'note-fabrique', 'Fabriquée !'), $('loupe-infos').firstChild);
      rafraichirEtat().then((ok) => { if (ok) { rendreJoueurs(); rendreFil(); } });
    } catch (e) {
      bouton.disabled = false;
      bouton.textContent = 'Fabriquer';
      gererErreur(e);
    }
  }

  /* ====================================================================
     Collections des joueurs et fil
     ==================================================================== */
  function rendreJoueurs() {
    const zone = $('joueurs');
    zone.textContent = '';
    if (!etat.public) { zone.appendChild(el('div', 'vide', etat.panne ? 'Serveur injoignable : impossible d’afficher les collections.' : 'Chargement…')); return; }
    const total = etat.catalogue.cartes.length;
    etat.public.joueurs.forEach((j) => {
      const d = el('div', 'carte-joueur', null, { role: 'button', tabindex: '0' });
      d.style.setProperty('--couleur', couleurJoueur(j));
      const nom = el('div', 'nom');
      nom.appendChild(el('span', null, j.nom));
      if (etat.session && j.id === etat.session.joueur) nom.appendChild(el('span', 'moi', 'moi'));
      d.appendChild(nom);
      const pts = el('div', 'points', String(j.nbCartes));
      pts.appendChild(el('small', null, `/ ${total} cartes`));
      d.appendChild(pts);
      const barre = el('div', 'barre-mini');
      const i = el('i');
      i.style.width = `${(j.nbCartes / total) * 100}%`;
      barre.appendChild(i);
      d.appendChild(barre);
      const rar = el('div', 'raretes-joueur');
      const comptes = compterRaretes(j.cartes);
      etat.catalogue.raretes.forEach((r) => {
        const s = el('span', `r-${r.id}`, null, { title: `${r.nom} : ${comptes[r.id] || 0} / ${(etat.parRarete.get(r.id) || []).length}` });
        s.append(gemmes(r.id), el('b', null, String(comptes[r.id] || 0)));
        rar.appendChild(s);
      });
      d.appendChild(rar);
      const offerts = offertsDe(j);
      d.appendChild(el('div', 'detail', `${pluriel(j.boostersDispo, 'booster')} à ouvrir${offerts ? ` (dont ${offerts.stock} offert${offerts.stock > 1 ? 's' : ''})` : ''} · ${j.boostersOuverts} ouvert${j.boostersOuverts > 1 ? 's' : ''} sur ${j.boostersGagnes} gagné${j.boostersGagnes > 1 ? 's' : ''}`));
      d.appendChild(el('div', 'detail', `${pluriel(j.fragments, 'fragment')}${j.compte ? '' : ' · pas encore de mot de passe'}`));
      const b = el('button', 'bouton secondaire petit', 'Voir l’album', { type: 'button' });
      const voir = () => { etat.albumJoueur = j.id; mettreAJourAlbum(); if (location.hash !== '#collection') location.hash = '#collection'; else window.scrollTo({ top: 0 }); };
      b.addEventListener('click', (e) => { e.stopPropagation(); voir(); });
      d.addEventListener('click', voir);
      d.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); voir(); } });
      d.appendChild(b);
      zone.appendChild(d);
    });
  }
  function rendreFil() {
    const ol = $('fil');
    ol.textContent = '';
    if (!etat.public) return;
    const fil = etat.public.fil || [];
    if (!fil.length) { ol.appendChild(el('li', null, 'Rien pour le moment : ouvrez des boosters !')); return; }
    fil.forEach((entree) => {
      const j = etat.public.joueurs.find((x) => x.id === entree.joueur) || null;
      const c = etat.cartes.get(entree.carte);
      if (!c) return;
      const li = el('li', `r-${c.rarete}`);
      const past = el('span', 'pastille');
      past.style.background = j ? couleurJoueur(j) : '#888';
      li.appendChild(past);
      li.appendChild(el('span', 'qui', j ? j.nom : entree.joueur));
      const quoi = el('span', 'quoi');
      quoi.append(el('span', null, entree.fabriquee ? 'a fabriqué ' : 'a tiré '), el('b', null, `${c.prenom} ${c.nom}`), el('span', null, ` (${nomEcurie(c.ecurie)}) `), gemmes(c.rarete), el('span', null, ' '), el('span', 'rarete-nom', rareteDe(c.rarete).nom));
      quoi.addEventListener('click', () => ouvrirLoupe(c, j));
      li.appendChild(quoi);
      if (entree.fabriquee) li.appendChild(el('span', 'badge', 'fabriquée'));
      li.appendChild(el('span', 'quand', formaterDate(entree.date)));
      ol.appendChild(li);
    });
  }

  /* ====================================================================
     Pronostics : un pari gratuit avant chaque GP (le meilleur d'entre nous, l'ordre d'arrivée), des boosters à gagner.
     Le serveur ouvre le GP, fige les cotes, ferme au départ et règle après la course (voir API.md).
     ==================================================================== */
  const pronosDe = () => (etat.public && etat.public.pronos) || null;
  function pronosVisibles() {
    const p = pronosDe();
    return !!p && (p.actif || p.manche !== null || (p.historique || []).length > 0);
  }
  const nomJoueur = (id) => { const j = etat.public && etat.public.joueurs.find((x) => x.id === id); return j ? j.nom : id; };
  function couleurJoueurId(id) {
    const j = etat.public && etat.public.joueurs.find((x) => x.id === id);
    return j ? couleurJoueur(j) : '#888';
  }
  const formaterCote = (c) => `×${(typeof c === 'number' ? c : 0).toFixed(1).replace('.', ',')}`;
  const ordreParDefaut = (p) => Object.keys(p.forces).sort((a, b) => p.forces[b] - p.forces[a]);  // le favori en premier
  function majOngletPronos() {
    const lien = $('onglet-pronostics');
    if (lien) lien.hidden = !pronosVisibles();
    if (etat.afficherOnglet) etat.afficherOnglet();
  }
  const clePari = (p) => (etat.session ? `${etat.session.joueur}|${p.manche}` : null);
  const pariEnregistre = (p) => (etat.monPari && etat.monPari.manche === p.manche ? etat.monPari.pari : null);

  /* Le formulaire se remplit avec le pari déjà enregistré ; ce qu'on modifie reste dans le brouillon pendant les rafraîchissements.
     Le pari de l'ordre n'est joué que si on y touche (ou si on coche la case) : on n'enregistre jamais un ordre par défaut sans le savoir. */
  function brouillonPronos(p) {
    const cle = clePari(p);
    let b = etat.brouillon;
    if (!b || b.cle !== cle) b = etat.brouillon = { cle, meilleur: null, ordre: ordreParDefaut(p), jouerOrdre: false, modifie: false, depuisSauvegarde: false };
    const sauve = pariEnregistre(p);
    if (sauve && !b.modifie && !b.depuisSauvegarde) {
      b.meilleur = sauve.meilleur || null;
      b.ordre = sauve.ordre ? sauve.ordre.slice() : ordreParDefaut(p);
      b.jouerOrdre = !!sauve.ordre;
      b.depuisSauvegarde = true;
    }
    return b;
  }
  /* Demande au serveur le pari déjà enregistré par ce joueur pour ce GP. Une réponse n'est gardée que si le joueur et le GP
     sont toujours les mêmes (déconnexion / reconnexion ou GP suivant pendant la requête : réponse ignorée). */
  async function chargerMonPari() {
    const p = pronosDe();
    if (!etat.session || !p || p.manche === null || !etat.api.monPronostic) return;
    const cle = clePari(p);
    if (etat.suiviPari && etat.suiviPari.cle === cle) return;  // déjà demandé (en cours, réussi, ou en échec : « Réessayer » le relance)
    const jeton = etat.session.jeton;
    const suivi = etat.suiviPari = { cle, etat: 'chargement' };
    rendrePronos();
    try {
      const r = await etat.api.monPronostic(jeton);
      if (etat.suiviPari !== suivi) return;
      etat.monPari = r;
      suivi.etat = 'ok';
    } catch (e) {
      if (etat.suiviPari !== suivi) return;
      if (e && e.code === 401) { gererErreur(e); return; }
      suivi.etat = 'erreur';
    }
    rendrePronos();
  }
  const texteParis = (meilleur, ordre) => (meilleur && ordre ? 'meilleur + ordre' : (meilleur ? 'meilleur' : 'ordre'));
  async function envoyerPari(p) {
    const b = etat.brouillon, moi = joueurConnecte();
    if (!b || !moi || etat.envoiPari) return;
    const meilleur = p.bases.meilleur > 0 ? b.meilleur : null;
    const ordre = p.bases.ordre > 0 && b.jouerOrdre ? b.ordre.slice() : null;
    if (!meilleur && !ordre) { notifier('Choisissez au moins un pronostic.'); return; }
    etat.envoiPari = true;
    rendrePronos();
    try {
      const r = await etat.api.pronostiquer(etat.session.jeton, meilleur, ordre, p.manche);
      etat.monPari = { manche: r.manche, statut: r.statut, pari: r.pari };
      etat.suiviPari = { cle: `${moi.id}|${r.manche}`, etat: 'ok' };
      b.modifie = false;
      b.depuisSauvegarde = false;
      notifier(`Pronostic enregistré (${texteParis(meilleur, ordre)}) ! Il reste secret jusqu’à la fermeture.`, 'succes');
    } catch (e) {
      if (e && e.code === 409) {
        notifier(e.message);
        await rafraichirEtat(false, true);
        etat.suiviPari = null; etat.monPari = null; etat.brouillon = null;  // le GP a peut-être changé : on repart du serveur
      } else gererErreur(e);
    } finally {
      etat.envoiPari = false;
      rendrePronos();
    }
  }

  function rendreEtatPronos(p) {
    const zone = $('pronos-etat');
    zone.textContent = '';
    if (p.manche !== null) {
      const gp = el('span', 'puce'); gp.append(el('b', null, `GP n°${p.manche}`), el('span', null, p.gp ? ` · ${p.gp}` : '')); zone.appendChild(gp);
      zone.appendChild(el('span', `etat-pari ${p.statut}`, p.statut === 'ouvert' ? 'Pronostics ouverts' : 'Pronostics fermés'));
      if (p.statut === 'ouvert') {
        const n = Object.keys(p.aParie || {}).filter((id) => p.aParie[id]).length, total = Object.keys(p.aParie || {}).length;
        const c = el('span', 'puce'); c.append(el('b', null, `${n} / ${total}`), el('span', null, n > 1 ? ' ont parié' : ' a parié')); zone.appendChild(c);
      }
    }
    const regles = $('pronos-regles');
    if (regles && p.bases) {
      const parties = [];
      if (p.bases.meilleur > 0) parties.push(`« meilleur d’entre nous » : ${p.bases.meilleur} boosters × la cote`);
      if (p.bases.ordre > 0) parties.push(`« ordre d’arrivée » : ${p.bases.ordre} boosters × la cote`);
      regles.textContent = parties.length ? ` Gain d’un pari juste : ${parties.join(' ; ')} (au plus ${p.bases.max} boosters par pari).` : '';
    }
  }

  function formulairePronos(p) {
    const moi = joueurConnecte();
    const suivi = etat.suiviPari && etat.suiviPari.cle === clePari(p) ? etat.suiviPari : null;
    const aDejaParie = !!(p.aParie && p.aParie[moi.id]) || !!pariEnregistre(p);
    // Un pari déjà enregistré doit être chargé avant d'afficher le formulaire : sinon un clic le remplacerait par l'ordre par défaut
    if (aDejaParie && !pariEnregistre(p) && (!suivi || suivi.etat !== 'ok')) {
      const attente = el('div', 'pari-form');
      if (suivi && suivi.etat === 'erreur') {
        attente.appendChild(el('p', 'aide', 'Impossible de charger votre pronostic pour le moment (le serveur ne répond pas).'));
        const reessayer = el('button', 'bouton secondaire petit', 'Réessayer', { type: 'button', 'data-f': 'reessayer' });
        reessayer.addEventListener('click', () => { etat.suiviPari = null; rendrePronos(); });
        attente.appendChild(reessayer);
      } else {
        attente.appendChild(el('p', 'aide', 'Chargement de votre pronostic…'));
      }
      return attente;
    }
    const b = brouillonPronos(p);
    const f = el('div', 'pari-form');
    if (p.bases.meilleur > 0) {
      const bloc = el('div', 'pari-bloc');
      bloc.appendChild(el('h4', null, 'Qui sera le meilleur d’entre nous ?', { id: 'pari-meilleur-titre' }));
      const grille = el('div', 'choix-joueurs', null, { role: 'group', 'aria-labelledby': 'pari-meilleur-titre' });
      Object.keys(p.cotes.meilleur).forEach((id) => {
        const cote = p.cotes.meilleur[id], gain = gainPronos(p.bases.meilleur, cote, p.bases.max);
        const bouton = el('button', 'choix', null, { type: 'button', 'aria-pressed': b.meilleur === id ? 'true' : 'false', 'data-f': `choix-${id}` });
        bouton.style.setProperty('--couleur', couleurJoueurId(id));
        bouton.append(el('b', null, nomJoueur(id)), el('span', 'cote', formaterCote(cote)), el('small', null, `+${pluriel(gain, 'booster')} si juste`));
        bouton.addEventListener('click', () => { b.meilleur = b.meilleur === id ? null : id; b.modifie = true; rendrePronos(); });
        grille.appendChild(bouton);
      });
      bloc.appendChild(grille);
      f.appendChild(bloc);
    }
    if (p.bases.ordre > 0) {
      const bloc = el('div', 'pari-bloc');
      bloc.appendChild(el('h4', null, 'Dans quel ordre allez-vous finir ?'));
      const jouer = el('label', 'pari-jouer');
      const caseJouer = el('input', null, null, { type: 'checkbox', 'data-f': 'jouer-ordre' });
      caseJouer.checked = b.jouerOrdre;
      caseJouer.addEventListener('change', () => { b.jouerOrdre = caseJouer.checked; b.modifie = true; rendrePronos(); });
      jouer.append(caseJouer, el('span', null, ' Je joue aussi ce pari (déplacer un joueur le coche)'));
      bloc.appendChild(jouer);
      const liste = el('ol', 'ordre-liste' + (b.jouerOrdre ? '' : ' inactif'));
      b.ordre.forEach((id, i) => {
        const li = el('li');
        li.style.setProperty('--couleur', couleurJoueurId(id));
        li.append(el('span', 'place', String(i + 1)), el('span', 'pastille'), el('b', null, nomJoueur(id)));
        const deplacer = (delta) => { const k = i + delta; [b.ordre[i], b.ordre[k]] = [b.ordre[k], b.ordre[i]]; b.jouerOrdre = true; b.modifie = true; rendrePronos(); };
        const haut = el('button', 'bouton secondaire petit', '↑', { type: 'button', 'aria-label': `Monter ${nomJoueur(id)}`, 'data-f': `haut-${id}` });
        const bas = el('button', 'bouton secondaire petit', '↓', { type: 'button', 'aria-label': `Descendre ${nomJoueur(id)}`, 'data-f': `bas-${id}` });
        haut.disabled = i === 0;
        bas.disabled = i === b.ordre.length - 1;
        haut.addEventListener('click', () => deplacer(-1));
        bas.addEventListener('click', () => deplacer(1));
        li.append(haut, bas);
        liste.appendChild(li);
      });
      bloc.appendChild(liste);
      const cote = coteOrdre(p.forces, b.ordre, p.bases.ordre, p.bases.max);
      bloc.appendChild(el('p', 'ordre-cote', `Cote ${formaterCote(cote)} : +${pluriel(gainPronos(p.bases.ordre, cote, p.bases.max), 'booster')} si l’ordre est exact. Un absent est simplement retiré de l’ordre (la cote est alors recalculée).`));
      f.appendChild(bloc);
    }
    const sauve = pariEnregistre(p);
    const valider = el('button', 'bouton', sauve ? 'Modifier mon pronostic' : 'Valider mon pronostic', { type: 'button', 'data-f': 'valider' });
    valider.disabled = !!etat.envoiPari;
    valider.addEventListener('click', () => envoyerPari(p));
    const bas = el('div', 'actions pari-actions');
    bas.appendChild(valider);
    const aEnregistrer = texteParis(p.bases.meilleur > 0 && b.meilleur, p.bases.ordre > 0 && b.jouerOrdre);
    bas.appendChild(el('span', 'pari-statut', sauve && !b.modifie
      ? 'Pronostic enregistré : modifiable jusqu’à la fermeture.'
      : ((b.meilleur && p.bases.meilleur > 0) || (b.jouerOrdre && p.bases.ordre > 0)
        ? `${sauve ? 'Modifications non enregistrées · ' : ''}Sera enregistré : ${aEnregistrer}. Aucune mise : vous ne pouvez rien perdre.`
        : 'Choisissez un joueur, ou déplacez l’ordre, puis validez. Aucune mise : vous ne pouvez rien perdre.')));
    f.appendChild(bas);
    if (sauve) f.appendChild(el('p', 'aide pari-gains', resumePari(sauve)));
    return f;
  }
  function resumePari(pari) {
    const parties = [];
    if (pari.meilleur) parties.push(`meilleur : ${nomJoueur(pari.meilleur)} (${formaterCote(pari.cotes.meilleur)}, +${pluriel(pari.gains.meilleur, 'booster')})`);
    if (pari.ordre) parties.push(`ordre : ${pari.ordre.map(nomJoueur).join(' › ')} (${formaterCote(pari.cotes.ordre)}, +${pluriel(pari.gains.ordre, 'booster')})`);
    return `Votre pronostic — ${parties.join(' · ')}.`;
  }

  /* Les paris de tout le monde, une fois les pronostics fermés */
  function parisReveles(p) {
    const t = el('table', 'pronos-table');
    const entete = el('tr');
    ['Joueur', 'Meilleur d’entre nous', 'Ordre d’arrivée'].forEach((x) => entete.appendChild(el('th', null, x)));
    t.appendChild(el('thead')).appendChild(entete);
    const corps = el('tbody');
    const moi = joueurConnecte();
    (etat.public.joueurs || []).forEach((j) => {
      const pari = (p.paris || {})[j.id];
      const tr = el('tr', moi && moi.id === j.id ? 'est-moi' : null);
      const nom = el('td'), pastille = el('span', 'pastille');
      pastille.style.background = couleurJoueur(j);
      nom.append(pastille, el('b', null, ` ${j.nom}`));
      tr.appendChild(nom);
      if (!pari) { const td = el('td', 'discret', 'N’a pas parié'); td.colSpan = 2; tr.appendChild(td); }
      else {
        tr.appendChild(el('td', null, pari.meilleur ? `${nomJoueur(pari.meilleur)} (${formaterCote(p.cotes.meilleur[pari.meilleur])})` : '–'));
        tr.appendChild(el('td', 'ordre', pari.ordre ? pari.ordre.map(nomJoueur).join(' › ') : '–'));
      }
      corps.appendChild(tr);
    });
    t.appendChild(corps);
    const enveloppe = el('div', 'tableau-defilant');
    enveloppe.appendChild(t);
    return enveloppe;
  }
  function rendreGpPronos(p) {
    const zone = $('pronos-gp');
    zone.textContent = '';
    const connecte = !!joueurConnecte();
    $('pronos-hors-ligne').hidden = !(p.manche !== null && p.statut === 'ouvert' && p.actif && !etat.session);
    const attente = (p.enAttente || []).map((x) => x.gp || `n°${x.manche}`);
    if (attente.length) {
      zone.appendChild(el('p', 'aide', `Résultat du GP ${attente.join(', ')} en cours de vérification : les gains seront versés dès qu’il sera validé.`));
    }
    if (p.manche === null) {
      zone.appendChild(el('div', 'vide', p.actif
        ? 'Pas de Grand Prix à pronostiquer pour le moment : le prochain s’ouvrira dès que le précédent aura été enregistré.'
        : 'Les pronostics sont désactivés pour le moment.'));
      return;
    }
    const bloc = el('div', 'pronos-gp');
    bloc.appendChild(el('h3', null, `Grand Prix ${p.gp || `n°${p.manche}`}`));
    if (p.statut === 'ouvert' && p.actif) {
      if (connecte) {
        bloc.appendChild(formulairePronos(p));
      } else {
        bloc.appendChild(el('p', 'aide', 'Cotes du moment, figées pour tout le GP.'));
        const grille = el('div', 'choix-joueurs lecture');
        Object.keys(p.cotes.meilleur).forEach((id) => {
          const c = el('div', 'choix');
          c.style.setProperty('--couleur', couleurJoueurId(id));
          c.append(el('b', null, nomJoueur(id)), el('span', 'cote', formaterCote(p.cotes.meilleur[id])), el('small', null, `+${pluriel(gainPronos(p.bases.meilleur, p.cotes.meilleur[id], p.bases.max), 'booster')} si juste`));
          grille.appendChild(c);
        });
        if (p.bases.meilleur > 0) bloc.appendChild(grille);
      }
    } else if (p.statut === 'ouvert') {
      bloc.appendChild(el('p', 'aide', 'Les pronostics sont désactivés : ce GP sera réglé avec les paris déjà enregistrés.'));
    } else {
      bloc.appendChild(el('p', 'aide', 'Les pronostics sont fermés. Voici les paris de chacun ; le résultat est pris en compte quelques minutes après la course.'));
      bloc.appendChild(parisReveles(p));
    }
    if (etat.demo) {
      const ligne = el('div', 'pari-demo');
      if (p.statut === 'ouvert' && etat.api.fermerPronos) {
        const fermer = el('button', 'bouton secondaire petit', 'Fermer les pronostics (démo)', { type: 'button', 'data-f': 'fermer-demo' });
        fermer.addEventListener('click', async () => {
          fermer.disabled = true;
          try { await etat.api.fermerPronos(); await rafraichirEtat(false, true); rendrePronos(); }
          catch (e) { gererErreur(e); } finally { fermer.disabled = false; }
        });
        ligne.appendChild(fermer);
      }
      const sim = el('button', 'bouton secondaire petit', 'Simuler la course (démo)', { type: 'button', 'data-f': 'simuler' });
      sim.addEventListener('click', async () => {
        sim.disabled = true;
        try { await etat.api.simulerCourse(); await rafraichirEtat(false, true); etat.suiviPari = null; etat.monPari = null; etat.brouillon = null; rendreTout(); }
        catch (e) { gererErreur(e); } finally { sim.disabled = false; }
      });
      ligne.append(sim, el('span', 'discret', ' Mode démo : ferme les pronostics, ou joue la course tout de suite (les autres joueurs parient au hasard) et ouvre le GP suivant.'));
      bloc.appendChild(ligne);
    }
    zone.appendChild(bloc);
  }

  function rendreHistoriquePronos(p) {
    const zone = $('pronos-historique');
    zone.textContent = '';
    if (!(p.historique || []).length) {
      zone.appendChild(el('div', 'vide', 'Aucun GP réglé pour le moment : les résultats apparaîtront ici après la course.'));
      return;
    }
    p.historique.forEach((h) => {
      const carte = el('article', 'pronos-resultat');
      carte.appendChild(el('h4', null, `GP n°${h.manche} · ${h.gp}`));
      if (h.resultat && h.resultat.annulee) {
        carte.appendChild(el('p', 'aide', 'GP sans résultat exploitable (moins de deux d’entre vous au départ, ou GP annulé) : aucun gain.'));
        zone.appendChild(carte);
        return;
      }
      const arrivee = el('p', 'arrivee');
      arrivee.appendChild(el('span', 'discret', 'Arrivée : '));
      (h.resultat ? h.resultat.classement : []).forEach((id, i) => {
        const c = el('span', 'chip-arrivee', `${i + 1}. ${nomJoueur(id)}`);
        c.style.setProperty('--couleur', couleurJoueurId(id));
        arrivee.appendChild(c);
      });
      const absents = (h.resultat && h.resultat.absents) || [];
      if (absents.length) arrivee.appendChild(el('span', 'discret', ` · ${absents.length > 1 ? 'absents' : 'absent'} : ${absents.map(nomJoueur).join(', ')}`));
      carte.appendChild(arrivee);
      const parieurs = Object.keys(h.paris || {});
      if (parieurs.length) {
        const t = el('table', 'pronos-table');
        const tr0 = el('tr');
        ['Joueur', 'Meilleur', 'Gain', 'Ordre'].forEach((x, i) => tr0.appendChild(el('th', i === 2 ? 'num' : null, x)));  // l'ordre, la colonne la plus large, à la fin
        t.appendChild(el('thead')).appendChild(tr0);
        const corps = el('tbody');
        parieurs.forEach((id) => {
          const pari = h.paris[id], g = (h.gains && h.gains[id]) || { meilleur: 0, ordre: 0 };
          const tr = el('tr');
          tr.appendChild(el('td', null, nomJoueur(id)));
          const m = el('td'); if (pari.meilleur) { m.appendChild(el('span', g.meilleur > 0 ? 'juste' : 'rate', g.meilleur > 0 ? '✓ ' : '✗ ')); m.appendChild(el('span', null, nomJoueur(pari.meilleur))); } else m.textContent = '–';
          const o = el('td', 'ordre'); if (pari.ordre) { o.appendChild(el('span', g.ordre > 0 ? 'juste' : 'rate', g.ordre > 0 ? '✓ ' : '✗ ')); o.appendChild(el('span', null, pari.ordre.map(nomJoueur).join(' › '))); } else o.textContent = '–';
          const gain = g.meilleur + g.ordre;
          tr.append(m, el('td', 'num' + (gain > 0 ? ' juste' : ''), gain > 0 ? `+${gain}` : '0'), o);
          corps.appendChild(tr);
        });
        t.appendChild(corps);
        const enveloppe = el('div', 'tableau-defilant');
        enveloppe.appendChild(t);
        carte.appendChild(enveloppe);
      } else {
        carte.appendChild(el('p', 'aide', 'Personne n’avait parié sur ce GP.'));
      }
      zone.appendChild(carte);
    });
  }
  function rendreClassementPronos(p) {
    const t = $('pronos-classement');
    t.textContent = '';
    const tr0 = el('tr');
    ['#', 'Joueur', 'Boosters gagnés', 'Paris', 'Bon « meilleur »', 'Bon « ordre »'].forEach((x, i) => tr0.appendChild(el('th', i >= 2 ? 'num' : null, x)));
    t.appendChild(el('thead')).appendChild(tr0);
    const corps = el('tbody');
    (p.classement || []).forEach((c, i) => {
      const tr = el('tr');
      tr.append(el('td', null, String(i + 1)), el('td', null, nomJoueur(c.joueur)),
        el('td', 'num total', String(c.boosters)), el('td', 'num', String(c.paris)), el('td', 'num', String(c.bonsMeilleur)), el('td', 'num', String(c.bonsOrdre)));
      corps.appendChild(tr);
    });
    t.appendChild(corps);
  }
  /* Une seule fois par GP réglé : « +N boosters » quand ses pronostics ont rapporté. La mémoire est le navigateur (et, si le stockage
     est bloqué, la page elle-même) ; à la première visite, on mémorise où on en est sans rien annoncer. */
  function signalerGainsPronos(p) {
    const moi = joueurConnecte();
    if (!moi) return;
    const cle = `f1cartes.${etat.demo ? 'demo.' : ''}pronos.vu.${moi.id}`;
    const dernier = (p.historique || []).length ? Math.max(...p.historique.map((h) => h.manche)) : 0;
    const lu = stockage.lire(cle);
    const vu = typeof lu === 'number' ? lu : (typeof etat.pronosVu[cle] === 'number' ? etat.pronosVu[cle] : null);
    const noter = (n) => { etat.pronosVu[cle] = n; stockage.ecrire(cle, n); };
    if (vu === null) { noter(dernier); return; }
    if (vu >= dernier) return;
    noter(dernier);
    const nouveaux = p.historique.filter((h) => h.manche > vu && !(h.resultat && h.resultat.annulee));
    const total = nouveaux.reduce((s, h) => { const g = (h.gains && h.gains[moi.id]) || { meilleur: 0, ordre: 0 }; return s + g.meilleur + g.ordre; }, 0);
    if (total > 0) notifier(`Pronostics : +${pluriel(total, 'booster')} gagné${total > 1 ? 's' : ''} (${nouveaux.map((h) => h.gp).join(', ')}) !`, 'succes');
  }
  /* Toute erreur de rendu de cet onglet (données inattendues venues du serveur) reste dans l'onglet : le reste de la page et ses minuteries continuent. */
  function rendrePronos() {
    try { dessinerPronos(); } catch (e) { console.error(e); }
  }
  function dessinerPronos() {
    majOngletPronos();
    const p = pronosDe();
    if (!p || !pronosVisibles() || !$('pronos-gp')) return;  // sans le bloc HTML (ancienne page en cache), rien à dessiner
    const moi = joueurConnecte();
    if (moi && pariEnregistre(p) && p.aParie) p.aParie[moi.id] = true;
    const actif = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.f : null;
    rendreEtatPronos(p);
    rendreGpPronos(p);
    rendreHistoriquePronos(p);
    rendreClassementPronos(p);
    if (actif) {  // le focus clavier reste sur le même bouton ; s'il est devenu inactif (↑ en tête), sur son voisin
      const noeuds = Array.from(document.querySelectorAll('#pronos-gp [data-f]'));
      let cible = noeuds.find((n) => n.dataset.f === actif);
      if (cible && cible.disabled) {
        const frere = actif.startsWith('haut-') ? actif.replace('haut-', 'bas-') : (actif.startsWith('bas-') ? actif.replace('bas-', 'haut-') : null);
        cible = frere ? noeuds.find((n) => n.dataset.f === frere) : null;
      }
      if (cible && !cible.disabled) cible.focus();
    }
    signalerGainsPronos(p);
    chargerMonPari();
  }

  /* ====================================================================
     Crédits photos (repliables, construits à la première ouverture)
     ==================================================================== */
  function nbPhotos() {
    const pilotes = (etat.catalogue && etat.catalogue.pilotes) || {};
    return Object.keys(pilotes).filter((id) => pilotes[id] && pilotes[id].photo).length;
  }
  function construireCredits() {
    if (etat.creditsConstruits) return;
    etat.creditsConstruits = true;
    const liste = $('credits-liste');
    liste.textContent = '';
    const pilotes = (etat.catalogue && etat.catalogue.pilotes) || {};
    Object.keys(pilotes)
      .filter((id) => pilotes[id] && pilotes[id].photo)
      .map((id) => { const n = etat.pilotes.get(id) || { prenom: '', nom: id }; return { id, p: pilotes[id], nom: `${n.prenom} ${n.nom}`.trim(), tri: normaliser(`${n.nom} ${n.prenom}`) }; })
      .sort((a, b) => a.tri.localeCompare(b.tri, 'fr'))
      .forEach(({ p, nom }) => {
        const li = el('li');
        li.appendChild(el('b', null, nom));
        li.appendChild(el('span', null, ' — '));
        li.appendChild(el('span', 'credit-auteur', tronquer(p.auteur || 'auteur inconnu', 90), { title: p.auteur || '' }));
        li.appendChild(el('span', null, ' · '));
        li.appendChild(lienExterne(p.licence || 'licence libre', p.lienLicence));
        li.appendChild(el('span', null, ' · '));
        li.appendChild(lienExterne('source', p.source));
        liste.appendChild(li);
      });
  }
  function initialiserCredits() {
    const details = $('credits');
    const n = nbPhotos();
    $('credits-titre').textContent = `Crédits photos (${pluriel(n, 'pilote')})`;
    details.hidden = n === 0;
    details.addEventListener('toggle', () => { if (details.open) construireCredits(); });
    if (details.open) construireCredits();
  }
  function rendrePied() {
    const pied = $('pied');
    pied.textContent = '';
    const cat = etat.catalogue;
    if (nbPhotos()) {
      pied.appendChild(el('span', null, 'Photos : Wikimedia Commons, licences libres ('));
      const lien = el('a', null, 'voir les crédits', { href: '#credits' });
      lien.addEventListener('click', (e) => { e.preventDefault(); const d = $('credits'); d.open = true; d.scrollIntoView({ behavior: reduitMouvement ? 'auto' : 'smooth', block: 'start' }); });
      pied.appendChild(lien);
      pied.appendChild(el('span', null, '). Aucun logo officiel : casques, drapeaux et motifs sont dessinés en CSS/SVG. '));
    } else {
      pied.appendChild(el('span', null, 'Aucune photo ni logo : casques, drapeaux et motifs sont dessinés en CSS/SVG. '));
    }
    pied.appendChild(el('span', null, `Catalogue v${cat.version} généré le ${cat.genere} · ${cat.cartes.length} cartes.`));
  }

  /* ====================================================================
     Onglets et démarrage
     ==================================================================== */
  function initialiserOnglets() {
    const liens = Array.from(document.querySelectorAll('.onglets a'));
    const sections = Array.from(document.querySelectorAll('main > section'));
    function afficher() {
      let id = location.hash.replace('#', '');
      if (!sections.some((s) => s.id === id) || (id === 'pronostics' && !pronosVisibles())) id = etat.session ? 'boosters' : 'collections';
      sections.forEach((s) => { s.hidden = s.id !== id; });
      liens.forEach((a) => a.setAttribute('aria-selected', a.getAttribute('href') === '#' + id ? 'true' : 'false'));
      // sur petit écran la barre d'onglets défile : à chaque changement d'onglet, on amène le nouveau au centre (sans faire bouger la page)
      const actif = liens.find((a) => a.getAttribute('aria-selected') === 'true'), liste = actif && actif.parentElement;
      if (liste && id !== etat.ongletAffiche && liste.scrollWidth > liste.clientWidth) {
        const a = actif.getBoundingClientRect(), l = liste.getBoundingClientRect();
        liste.scrollLeft += (a.left + a.width / 2) - (l.left + l.width / 2);
      }
      etat.ongletAffiche = id;
    }
    window.addEventListener('hashchange', () => { afficher(); if (location.hash === '#pronostics') rafraichirPronos(); });
    etat.afficherOnglet = afficher;
    afficher();
  }
  /* Sur l'onglet Pronostics, l'état est relu à l'arrivée puis toutes les 45 s (ouverture, fermeture, résultats). */
  async function rafraichirPronos() {
    if (!etat.public || !pronosVisibles() || etat.occupe || etat.envoiPari || etat.rafraichitPronos) return;
    etat.rafraichitPronos = true;
    try {
      if (await rafraichirEtat(false, true) && !etat.occupe) {
        if (etat.suiviPari && etat.suiviPari.etat === 'erreur') etat.suiviPari = null;  // on retente de charger son pari
        rendreCompte();
        rendreBoosters(true);
        rendrePronos();
      }
    } finally { etat.rafraichitPronos = false; }
  }

  async function demarrer() {
    etat.demo = !window.CARTES_API || /[?&]demo(\b|=)/.test(location.search);
    const session = stockage.lire(CLE_SESSION);
    etat.session = session && session.jeton && session.joueur ? session : null;
    $('bandeau-demo').hidden = !etat.demo;
    $('btn-reinit-demo').addEventListener('click', () => {
      stockage.effacer(CLE_DEMO);
      stockage.effacer(CLE_SESSION);
      JOUEURS_DEMO.forEach((j) => stockage.effacer(`f1cartes.demo.pronos.vu.${j.id}`));
      location.reload();
    });
    document.querySelectorAll('[data-action="connexion"]').forEach((b) => b.addEventListener('click', ouvrirConnexion));
    initialiserOnglets();
    initialiserConnexion();
    initialiserFiltres();
    initialiserLoupe();
    initialiserBoosters();
    try { await chargerCatalogue(); }
    catch (e) { $('sous-titre').textContent = `Impossible de charger le catalogue des cartes (${e.message})`; notifier(e.message); return; }
    etat.api = etat.demo ? serveurDemo(etat.catalogue) : apiDistante(window.CARTES_API);
    preparerPaquet();
    remplirFiltres();
    rendreTableRaretes();
    construireAlbum();
    initialiserCredits();
    rendrePied();
    await Promise.all([rafraichirEtat(true), chargerSaison()]);
    rendreTout();
    setInterval(majCompteARebours, 1000);
    setInterval(() => { if (!document.hidden && location.hash === '#pronostics') rafraichirPronos(); }, 45000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden && etat.session && reglageOfferts()) rafraichirOfferts(); });
  }

  demarrer();
})();

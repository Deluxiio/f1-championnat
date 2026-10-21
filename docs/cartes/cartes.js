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
  const NB_PARTICULES = { commune: 0, peu_commune: 6, rare: 12, epique: 20, legendaire: 32, icone: 48 };
  const COULEURS_RARETE = { commune: '#a4a4ae', peu_commune: '#2fbf71', rare: '#3b8ff5', epique: '#9b4dca', legendaire: '#e8b923', icone: '#ffffff' };
  const PARTICULES_ICONE = ['#ff2d95', '#ff8a00', '#ffe600', '#2bff88', '#00c8ff', '#b36bff', '#ffffff'];

  const etat = {
    catalogue: null, cartes: new Map(), parRarete: new Map(), rang: new Map(), raretes: new Map(),
    api: null, demo: false, session: null, public: null, panne: false,
    albumJoueur: null, tuiles: new Map(), groupes: new Map(), albumConstruit: false,
    filtres: { recherche: '', rarete: '', ecurie: '', possession: 'toutes' },
    occupe: false, pioches: [], minuterie: null, nouvellesRecentes: new Set(),
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
  const rareteDe = (id) => etat.raretes.get(id) || { id, nom: id, regle: '', poids: 0, fragments: 0, cout: 0 };
  const nomEcurie = (id) => (etat.catalogue.ecuries[id] && etat.catalogue.ecuries[id].nom) || id;
  function couleursEcurie(id) {
    const e = etat.catalogue.ecuries[id];
    const c = (e && e.couleurs) || [];
    return [c[0] || '#888888', c[1] || '#dddddd', c[2] || '#222222'];
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
    function ajouterAuFil(joueur, carte, fabriquee) {
      if (rangLocal(carte.rarete) < rangLocal('epique')) return;
      donnees.fil.unshift({ joueur, carte: carte.id, date: new Date().toISOString(), fabriquee });
      donnees.fil.length = Math.min(donnees.fil.length, 30);
    }
    function vueJoueur(id) {
      const j = donnees.joueurs[id];
      return {
        id, nom: j.nom, compte: j.motDePasse !== null, points: BOOSTERS_DEMO,
        boostersGagnes: BOOSTERS_DEMO, boostersOuverts: j.boostersOuverts, boostersDispo: Math.max(0, BOOSTERS_DEMO - j.boostersOuverts),
        fragments: j.fragments, cartes: j.cartes.slice(), nbCartes: j.cartes.length,
      };
    }

    return {
      async etat() {
        return latence({ joueurs: JOUEURS_DEMO.map((j) => vueJoueur(j.id)), fil: donnees.fil.slice(0, 30), totalCartes: catalogue.cartes.length });
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
        const dispo = BOOSTERS_DEMO - j.boostersOuverts;
        if (dispo <= 0) echec(409, 'Aucun booster disponible.');
        const n = Math.max(1, Math.min(100, Math.floor(Number(nombre) || 1), dispo));
        const possedees = new Set(j.cartes);
        const boosters = [];
        for (let b = 0; b < n; b++) {
          const booster = [];
          for (let k = 0; k < catalogue.cartesParBooster; k++) {
            const carte = tirerCarte(tirerRarete(k === catalogue.cartesParBooster - 1 ? catalogue.derniereCarteMin : null));
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
          j.boostersOuverts++;
          boosters.push(booster);
        }
        sauver();
        return latence({ boosters, fragments: j.fragments, boostersDispo: Math.max(0, BOOSTERS_DEMO - j.boostersOuverts) });
      },
      async fabriquer(jeton, carteId) {
        const { id, j } = joueurParJeton(jeton);
        const carte = catalogue.cartes.find((c) => c.id === carteId);
        if (!carte) echec(404, 'Carte inconnue.');
        if (j.cartes.includes(carte.id)) echec(409, 'Vous possédez déjà cette carte.');
        const cout = rareteLocale(carte.rarete).cout;
        if (j.fragments < cout) echec(409, `Fragments insuffisants : il en faut ${cout}, vous en avez ${j.fragments}.`);
        j.fragments -= cout;
        j.cartes.push(carte.id);
        ajouterAuFil(id, carte, true);
        sauver();
        return latence({ carte: carte.id, fragments: j.fragments });
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
    });
  }
  function statsAffichees(c) {
    const s = c.stats || {};
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
    for (let i = 0; i < rangDe(rarete); i++) g.appendChild(el('b'));
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
    appliquerCouleurs(carte, couleursEcurie(c.ecurie));
    carte.setAttribute('role', 'img');
    carte.setAttribute('aria-label', `${c.prenom} ${c.nom} (${nomEcurie(c.ecurie)}), carte ${r.nom}, note ${c.note}`);
    const c3d = el('div', 'carte-3d');
    const face = el('div', 'face');

    const tete = el('header', 'tete');
    tete.append(el('span', 'numero', `${pad3(c.numero)}/${etat.catalogue.cartes.length}`), etiquetteRarete(c.rarete));
    face.appendChild(tete);

    const illu = el('div', 'illu');
    illu.appendChild(casqueSvg());
    const note = el('div', 'note', String(c.note));
    note.appendChild(el('small', null, 'Note'));
    illu.appendChild(note);
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
    if (typeof s.departs === 'number' && !lignes.some((l) => l[0] === 'Départs')) annees.appendChild(el('span', null, `${formaterNombre(s.departs)} départs`));
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
    bas.appendChild(el('small', null, '2000 — aujourd’hui'));
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
    if (possede) appliquerCouleurs(m, couleursEcurie(c.ecurie));
    else ['--c1', '--c2', '--c3'].forEach((v) => m.style.removeProperty(v));
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
  async function rafraichirEtat(initial) {
    try {
      etat.public = await etat.api.etat();
      etat.panne = false;
      return true;
    } catch (e) {
      etat.panne = true;
      if (initial) $('sous-titre').textContent = `Serveur injoignable — ${e.message}`;
      notifier(e.message);
      return false;
    }
  }

  /* ====================================================================
     Rendu général
     ==================================================================== */
  function rendreTout() {
    rendreSousTitre();
    rendreCompte();
    rendreBoosters();
    mettreAJourAlbum();
    rendreJoueurs();
    rendreFil();
  }
  function rendreSousTitre() {
    if (etat.panne && !etat.public) return;
    const total = etat.catalogue.cartes.length;
    $('sous-titre').textContent = `${total} cartes, une par couple pilote–écurie depuis 2000. 1 point au championnat = 1 booster de ${etat.catalogue.cartesParBooster} cartes.`;
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
        if (location.hash !== '#boosters') location.hash = '#boosters';
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
  function rendreBoosters() {
    const moi = joueurConnecte();
    $('boosters-hors-ligne').hidden = !!etat.session;
    $('boosters-zone').hidden = !etat.session;
    const compteur = $('boosters-compteur');
    compteur.textContent = '';
    const b1 = $('btn-ouvrir-1'), b10 = $('btn-ouvrir-10'), bt = $('btn-ouvrir-tout');
    if (!moi) {
      if (etat.session) compteur.appendChild(el('span', 'puce', etat.panne ? 'Serveur injoignable' : 'Données indisponibles'));
      b1.disabled = b10.disabled = bt.disabled = true;
      return;
    }
    const dispo = moi.boostersDispo;
    [[String(dispo), dispo > 1 ? ' boosters à ouvrir' : ' booster à ouvrir'], [`${moi.boostersOuverts} / ${moi.boostersGagnes}`, ' ouverts'], [String(moi.fragments), moi.fragments > 1 ? ' fragments' : ' fragment']]
      .forEach(([val, lib]) => { const p = el('span', 'puce'); p.append(el('b', null, val), el('span', null, lib)); compteur.appendChild(p); });
    b1.disabled = etat.occupe || dispo < 1;
    b10.disabled = etat.occupe || dispo < 10;
    bt.disabled = etat.occupe || dispo < 2;
    bt.textContent = dispo > 1 ? `Tout ouvrir (${dispo})` : 'Tout ouvrir';
    if (!etat.occupe) {
      $('indication').textContent = dispo
        ? `${pluriel(dispo, 'booster')} à ouvrir.`
        : 'Plus de booster pour le moment : marquez des points au championnat !';
      if (!dispo) $('paquet').hidden = true;
      else if ($('main-cartes').hidden && $('recap').hidden) $('paquet').hidden = false;
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
    const moi = joueurConnecte();
    if (!moi) return;
    const possedees = new Set(moi.cartes);
    (reponse.boosters || []).forEach((b) => b.forEach((t) => {
      if (t.nouvelle && !possedees.has(t.carte) && etat.cartes.has(t.carte)) { possedees.add(t.carte); moi.cartes.push(t.carte); etat.nouvellesRecentes.add(t.carte); }
    }));
    moi.nbCartes = moi.cartes.length;
    if (typeof reponse.fragments === 'number') moi.fragments = reponse.fragments;
    if (typeof reponse.boostersDispo === 'number') moi.boostersDispo = reponse.boostersDispo;
    moi.boostersOuverts += nbOuverts;
    rendreCompte();
    mettreAJourAlbum();
  }

  function couleursParticules(rarete) {
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
      scene.style.setProperty('--rc', c.rarete === 'icone' ? '#ffffff' : '#e8b923');
      scene.classList.remove('flash-scene');
      void scene.offsetWidth;
      scene.classList.add('flash-scene');
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
      rafraichirEtat().then((ok) => { if (ok && !etat.occupe) { rendreJoueurs(); rendreFil(); rendreCompte(); } });
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
    rafraichirEtat().then((ok) => { if (ok && !etat.occupe) { rendreJoueurs(); rendreFil(); rendreCompte(); } });
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
      grandes.forEach((c) => zone.appendChild(creerCarte(c, { cliquable: true })));
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
      tr.appendChild(el('td', 'num', `${r.poids} %`));
      tr.appendChild(el('td', 'num', `+${pluriel(r.fragments, 'fragment')}`));
      tr.appendChild(el('td', 'num', pluriel(r.cout, 'fragment')));
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
    if (!possede) {
      infos.appendChild(el('p', 'cout', `Carte manquante · fabrication : ${pluriel(r.cout, 'fragment')}`));
      if (!etat.session) infos.appendChild(el('p', 'ligne', 'Connectez-vous pour fabriquer cette carte avec vos fragments.'));
      else if (!j || !estMoi) infos.appendChild(el('p', 'ligne', j ? `Vous consultez l’album de ${j.nom}.` : ''));
      else {
        const assez = moi.fragments >= r.cout;
        if (!assez) infos.appendChild(el('p', 'ligne', `Vous avez ${pluriel(moi.fragments, 'fragment')} : il en manque ${r.cout - moi.fragments}.`));
        const b = el('button', 'bouton', assez ? `Fabriquer (${moi.fragments} fragments disponibles)` : 'Fabriquer', { type: 'button' });
        b.disabled = !assez;
        b.addEventListener('click', () => fabriquer(c, b));
        infos.appendChild(b);
      }
    } else if (j) {
      infos.appendChild(el('p', 'ligne', estMoi ? 'Dans votre collection.' : `Dans la collection de ${j.nom}.`));
    }
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
      d.appendChild(el('div', 'detail', `${pluriel(j.boostersDispo, 'booster')} à ouvrir · ${j.boostersOuverts} ouvert${j.boostersOuverts > 1 ? 's' : ''} sur ${j.boostersGagnes} gagné${j.boostersGagnes > 1 ? 's' : ''}`));
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
     Onglets et démarrage
     ==================================================================== */
  function initialiserOnglets() {
    const liens = Array.from(document.querySelectorAll('.onglets a'));
    const sections = Array.from(document.querySelectorAll('main > section'));
    function afficher() {
      let id = location.hash.replace('#', '');
      if (!sections.some((s) => s.id === id)) id = etat.session ? 'boosters' : 'collections';
      sections.forEach((s) => { s.hidden = s.id !== id; });
      liens.forEach((a) => a.setAttribute('aria-selected', a.getAttribute('href') === '#' + id ? 'true' : 'false'));
    }
    window.addEventListener('hashchange', afficher);
    afficher();
  }

  async function demarrer() {
    etat.demo = !window.CARTES_API || /[?&]demo(\b|=)/.test(location.search);
    const session = stockage.lire(CLE_SESSION);
    etat.session = session && session.jeton && session.joueur ? session : null;
    $('bandeau-demo').hidden = !etat.demo;
    $('btn-reinit-demo').addEventListener('click', () => { stockage.effacer(CLE_DEMO); stockage.effacer(CLE_SESSION); location.reload(); });
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
    $('pied').textContent = `Aucune photo ni logo : casques, drapeaux et motifs sont dessinés en CSS/SVG. Catalogue v${etat.catalogue.version} généré le ${etat.catalogue.genere} · ${etat.catalogue.cartes.length} cartes.`;
    await rafraichirEtat(true);
    rendreTout();
  }

  demarrer();
})();

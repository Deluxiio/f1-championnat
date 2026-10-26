/* Routeur du site : un seul document, plusieurs « pages » (panneaux) choisies par l'adresse (#/classement/duels…).
   Il tient le menu, le fil d'Ariane, le titre de la page et les onglets du téléphone. Il ne connaît ni le classement ni les cartes :
   les autres scripts lui parlent par événements sur `document` (jamais en appelant leurs fonctions internes).

   Entrées :  champ:donnees  { saison, calc }                           (app.js, à chaque rendu du classement)
              cartes:etat    { demo, session, moi, pronos, pronosVisibles, … }   (cartes.js, à chaque rendu des cartes)
   Sorties :  site:route     { id, section, vue, premier }              (id = panneau affiché, vue = « classement/duels »)
   API :      window.Site = { aller(chemin, { remplacer }), route(), definirTitre(id, { titre, sousTitre }) } */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const NS_SVG = 'http://www.w3.org/2000/svg';
  const TITRE_SITE = 'Championnat F1 25';

  const SECTIONS = {
    accueil: { titre: 'Accueil' },
    classement: { titre: 'Classement', parDefaut: 'classement/pilotes' },
    courses: { titre: 'Courses' },
    cartes: { titre: 'Cartes' },
  };
  const VUES = {
    'accueil': { panneau: 'accueil', section: 'accueil', nom: 'Accueil' },
    'classement/pilotes': { panneau: 'pilotes', section: 'classement', nom: 'Pilotes' },
    'classement/constructeurs': { panneau: 'ecuries', section: 'classement', nom: 'Constructeurs' },
    'classement/evolution': { panneau: 'evolution', section: 'classement', nom: 'Évolution' },
    'classement/duels': { panneau: 'duels', section: 'classement', nom: 'Duels' },
    'classement/stats': { panneau: 'stats', section: 'classement', nom: 'Stats' },
    'courses': { panneau: 'courses', section: 'courses', nom: 'Courses' },
    'cartes/boosters': { panneau: 'boosters', section: 'cartes', nom: 'Boosters' },
    'cartes/collection': { panneau: 'collection', section: 'cartes', nom: 'Ma collection' },
    'cartes/collections': { panneau: 'collections', section: 'cartes', nom: 'Collections' },
    'cartes/pronostics': { panneau: 'pronostics', section: 'cartes', nom: 'Pronostics' },
  };
  const PANNEAUX = Object.keys(VUES).map((v) => VUES[v].panneau);
  /* Adresses des anciennes pages (#pilotes, #boosters, cartes/#pronostics…) : toujours comprises, puis réécrites. */
  const ANCIENS = {
    pilotes: 'classement/pilotes', ecuries: 'classement/constructeurs', evolution: 'classement/evolution',
    duels: 'classement/duels', stats: 'classement/stats', calendrier: 'courses',
    boosters: 'cartes/boosters', collection: 'cartes/collection', collections: 'cartes/collections', pronostics: 'cartes/pronostics',
  };

  let courant = null;          // vue affichée : « classement/duels »
  let donnees = null;          // dernier champ:donnees
  let cartes = null;           // dernier cartes:etat (null tant que le jeu n'a pas répondu)
  const titres = {};           // titres propres à un panneau, donnés par les écrans : { accueil: { titre, sousTitre } }
  const deplaces = new Map();  // commandes remontées dans l'en-tête → leur place d'origine

  const sectionAvecVues = (s) => s === 'classement' || s === 'cartes';
  const pronosDispos = () => !!(cartes && cartes.pronosVisibles);

  function vueCartesParDefaut() {
    const app = window.CartesApp;
    return `cartes/${app && app.vueParDefaut ? app.vueParDefaut() : 'collections'}`;
  }

  /* Adresse (#…) → vue, ou null si ce n'est pas une adresse de page (ancre interne comme #contenu). */
  function analyser(hash) {
    let h = String(hash || '').replace(/^#/, '');
    if (h === '' || h === '/') return 'accueil';
    if (h[0] !== '/') return ANCIENS[h.toLowerCase()] || null;
    h = h.toLowerCase().replace(/\/+/g, '/').replace(/^\/|\/$/g, '');
    if (h === '' || h === 'accueil') return 'accueil';
    if (VUES[h]) return h;
    if (SECTIONS[h]) return h === 'cartes' ? vueCartesParDefaut() : (SECTIONS[h].parDefaut || h);
    return null;
  }
  const adresse = (vue) => (vue === 'accueil' ? '#/' : `#/${vue}`);

  /* Réécrit l'adresse sans ajouter d'entrée à l'historique (sans effet si le navigateur ou l'hôte le refuse) */
  function reecrire(hash) {
    try { history.replaceState(null, '', hash); } catch (e) { /* l'adresse affichée reste telle quelle, la page fonctionne */ }
  }

  /* --- Mise à jour de l'interface -------------------------------------------- */

  function majMenu(vue) {
    const section = VUES[vue].section;
    document.querySelectorAll('#menu [data-route]').forEach((a) => {
      const r = a.dataset.route;
      if (r === vue) a.setAttribute('aria-current', 'page');
      else if (r === section && sectionAvecVues(r)) a.setAttribute('aria-current', 'true');
      else a.removeAttribute('aria-current');
    });
    document.querySelectorAll('#onglets-bas [data-route]').forEach((a) => {
      if (a.dataset.route === section) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    });
    const pronos = $('menu-pronostics');
    if (pronos) pronos.hidden = !pronosDispos();
  }

  function chevron() {
    const svg = document.createElementNS(NS_SVG, 'svg');
    svg.setAttribute('aria-hidden', 'true');
    const use = document.createElementNS(NS_SVG, 'use');
    use.setAttribute('href', '#i-chevron');
    svg.appendChild(use);
    return svg;
  }
  function maillon(texte, href, actuel) {
    const e = document.createElement(actuel ? 'span' : 'a');
    e.textContent = texte;
    if (actuel) e.setAttribute('aria-current', 'page'); else e.href = href;
    return e;
  }
  function majFil(vue) {
    const v = VUES[vue], zone = $('fil-ariane');
    const maillons = [];
    if (vue === 'accueil') maillons.push(maillon('Accueil', '#/', true));
    else {
      maillons.push(maillon('Accueil', '#/', false));
      if (sectionAvecVues(v.section)) {
        maillons.push(maillon(SECTIONS[v.section].titre, `#/${v.section}`, false));
        maillons.push(maillon(v.nom, adresse(vue), true));
      } else maillons.push(maillon(SECTIONS[v.section].titre, adresse(vue), true));
    }
    zone.replaceChildren();
    maillons.forEach((m, i) => { if (i) zone.appendChild(chevron()); zone.appendChild(m); });
  }

  function majEntete(vue) {
    const v = VUES[vue], section = SECTIONS[v.section];
    const propre = titres[v.panneau] || {};
    const titreSite = (donnees && donnees.saison && donnees.saison.titre) || TITRE_SITE;
    $('titre-page').textContent = propre.titre || section.titre;
    $('sous-titre-page').textContent = propre.sousTitre || '';
    const morceaux = vue === 'accueil' ? [] : (sectionAvecVues(v.section) ? [v.nom, section.titre] : [section.titre]);
    document.title = [...morceaux, titreSite].join(' · ');
  }

  function majMarque() {
    const s = donnees && donnees.saison;
    if (!s) return;
    if (s.titre) $('marque-titre').textContent = s.titre;
    if (s.saison) $('marque-saison').textContent = s.saison;
  }

  /* Pastilles de sous-pages sur téléphone (le menu latéral n'y existe pas) */
  function majSousMenuMobile(vue) {
    const zone = $('sous-menu-mobile'), section = VUES[vue].section;
    zone.replaceChildren();
    if (!sectionAvecVues(section)) { zone.hidden = true; return; }
    zone.setAttribute('aria-label', SECTIONS[section].titre);
    Object.keys(VUES).filter((k) => VUES[k].section === section && (k !== 'cartes/pronostics' || pronosDispos())).forEach((k) => {
      const a = document.createElement('a');
      a.href = adresse(k);
      a.dataset.route = k;
      a.textContent = VUES[k].nom;
      if (k === vue) a.setAttribute('aria-current', 'page');
      zone.appendChild(a);
    });
    zone.hidden = false;
    // la pastille de la page courante reste visible dans la rangée qui défile
    const actuelle = zone.querySelector('[aria-current]');
    if (actuelle) {
      const a = actuelle.getBoundingClientRect(), z = zone.getBoundingClientRect();
      if (a.left < z.left + 16 || a.right > z.right - 16) zone.scrollLeft += (a.left + a.width / 2) - (z.left + z.width / 2);
    }
  }

  /* Les commandes d'un écran (bascules) marquées data-entete-actions montent à côté du titre de la page */
  function placerCommandes(panneau) {
    const zone = $('entete-actions');
    deplaces.forEach((place, el) => {
      if (el.parentNode !== zone) return;
      if (place.suivant && place.suivant.parentNode === place.parent) place.parent.insertBefore(el, place.suivant);
      else place.parent.appendChild(el);
    });
    const section = $(panneau);
    if (!section) return;
    section.querySelectorAll(':scope > [data-entete-actions]').forEach((el) => {
      deplaces.set(el, { parent: el.parentNode, suivant: el.nextSibling });
      zone.appendChild(el);
    });
  }

  function afficher(initial) {
    let vue = analyser(location.hash);
    if (vue === null) {
      if (!initial && !location.hash.startsWith('#/')) return;   // ancre interne (#contenu, #credits) : la page ne change pas
      vue = 'accueil';                                           // adresse de page inconnue (#/zzz) : retour à l'accueil
    }
    if (vue === 'cartes/pronostics' && cartes && cartes.chargee && !cartes.pronosVisibles) vue = vueCartesParDefaut();
    const voulue = adresse(vue);
    const brut = location.hash;
    const accueilNu = vue === 'accueil' && (brut === '' || brut === '#' || brut === '#/');
    if (!accueilNu && brut !== voulue) reecrire(voulue);

    const premier = courant === null, change = vue !== courant;
    courant = vue;
    const v = VUES[vue];
    PANNEAUX.forEach((id) => { const p = $(id); if (p) p.hidden = id !== v.panneau; });
    document.body.dataset.rubrique = v.section;
    document.body.dataset.page = vue;
    document.querySelectorAll('[data-section]').forEach((e) => e.classList.toggle('cache-section', e.dataset.section !== v.section));
    placerCommandes(v.panneau);
    majMenu(vue);
    majFil(vue);
    majEntete(vue);
    majSousMenuMobile(vue);
    if (!change) return;
    if (!premier) {
      window.scrollTo(0, 0);
      $('titre-page').focus({ preventScroll: true });
    }
    document.dispatchEvent(new CustomEvent('site:route', { detail: { id: v.panneau, section: v.section, vue, premier } }));
  }

  /* --- Événements des autres scripts ---------------------------------------- */

  document.addEventListener('champ:donnees', (e) => {
    donnees = e.detail;
    majMarque();
    if (courant) majEntete(courant);
  });
  document.addEventListener('cartes:etat', (e) => {
    cartes = e.detail;
    if (!courant) return;
    if (courant === 'cartes/pronostics' && cartes.chargee && !cartes.pronosVisibles) { Site.aller(vueCartesParDefaut(), { remplacer: true }); return; }
    majMenu(courant);
    majSousMenuMobile(courant);
  });

  const Site = window.Site = {
    /* Va à une page : 'accueil', 'classement', 'classement/duels', 'cartes/boosters'… */
    aller(chemin, options) {
      const vue = analyser(`#/${chemin}`) || 'accueil';
      if (options && options.remplacer) { reecrire(adresse(vue)); afficher(false); }
      else if (location.hash === adresse(vue)) afficher(false);
      else location.hash = adresse(vue);
    },
    route() { return courant; },
    /* Titre ou sous-titre propre à un panneau (ex. la phrase du tableau de bord) ; { titre, sousTitre } */
    definirTitre(id, titre) {
      titres[id] = titre || {};
      if (courant && VUES[courant].panneau === id) majEntete(courant);
    },
  };

  function demarrer() {
    try { sessionStorage.removeItem('f1.rechargee'); } catch (e) { /* stockage indisponible */ }   // repère posé par la garde de migration d'app.js
    window.addEventListener('hashchange', () => afficher(false));
    $('evitement').addEventListener('click', (e) => { e.preventDefault(); $('contenu').focus(); });
    afficher(true);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', demarrer);
  else demarrer();
})();

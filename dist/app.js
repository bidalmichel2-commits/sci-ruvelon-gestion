(function () {
  "use strict";

  const cfg = window.SCI_RUVELON_CONFIG || {};
  const PERSONAL_VEHICLE_COST_PER_KM = 0.47;
  const REPORT_CATEGORY = "compte_rendu";
  const REPORT_NOTE_CATEGORY = "annotation_compte_rendu";
  const ENERGY_CATEGORY = "depense_energie";
  const ENERGY_METERS_CATEGORY = "compteurs_energie";
  const MAINTENANCE_BUDGET_CATEGORY = "depense_entretien";
  const ENERGY_POSTS = [
    ["eau", "Eau potable", ""],
    ["edf_communs", "EDF communs", ""],
    ["compteur_1", "Électricité · Compteur 1", "E2, E3, E5, E6 et E7"],
    ["compteur_2", "Électricité · Compteur 2", "RC4, RC5, RC6, RC7 et RC8"]
  ];
  const PDF_DATA_PREFIX = "data:application/pdf;base64,";
  const REPORT_MAX_BYTES = 3 * 1024 * 1024;
  const LEASE_MAX_BYTES = 12 * 1024 * 1024;
  const hasConfig = !!(cfg.supabaseUrl && cfg.supabaseAnonKey && window.supabase);
  const sb = hasConfig ? window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey) : null;
  const tables = ["locaux", "locataires", "baux", "loyers_mensuels", "travaux", "remuneration_gerant"];
  const state = {
    route: "dashboard",
    month: currentMonth(),
    year: String(new Date().getFullYear()),
    travauxYear: "",
    travauxStatus: "",
    travauxSearch: "",
    travauxOrigin: "",
    entretienCategorie: "",
    etudeRecherche: "",
    reportRecords: [],
    reportId: "",
    reportsLoading: false,
    reportsError: "",
    annualLedgers: Object.fromEntries(["energie","entretien"].map(kind=>[kind,{records:[],year:currentMonth().slice(0,4),loading:false,error:""}])),
    user: null,
    profile: null,
    isAdmin: false,
    localMode: !hasConfig,
    installPrompt: null,
    data: Object.fromEntries(tables.map((t) => [t, []]))
  };

  const $ = (sel) => document.querySelector(sel);
  const euro = (v) => `${(Number(v) || 0).toFixed(2)} EUR`;
  const today = () => new Date().toISOString().slice(0, 10);
  const monthDate = (m) => `${String(m || currentMonth()).slice(0, 7)}-01`;
  const monthEndDate = (m) => {
    const [year, month] = String(m || currentMonth()).slice(0, 7).split("-").map(Number);
    return new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
  };
  const escapeHtml = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const uid = () => (crypto.randomUUID ? crypto.randomUUID() : `local-${Date.now()}-${Math.random().toString(16).slice(2)}`);

  function currentMonth() {
    return new Date().toISOString().slice(0, 7);
  }

  function addMonths(date, months) {
    const d = new Date(date);
    d.setMonth(d.getMonth() + months);
    return d;
  }

  function fmtDate(v) {
    if (!v) return "";
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) return v;
    return d.toLocaleDateString("fr-FR");
  }

  function tableKey(table) {
    return `ruvelon_v3_${table}`;
  }

  function localRead(table) {
    return JSON.parse(localStorage.getItem(tableKey(table)) || "[]");
  }

  function localWrite(table, rows) {
    localStorage.setItem(tableKey(table), JSON.stringify(rows));
  }

  function withComputed(table, row) {
    const r = { ...row };
    if (table === "loyers_mensuels") {
      r.loyer_ht = money(r.loyer_ht);
      r.tva = money(r.tva);
      r.loyer_ttc = money(r.loyer_ttc);
      r.charges_mensuelles = money(r.charges_mensuelles);
      r.total_attendu = money(r.total_attendu || (r.loyer_ttc + r.charges_mensuelles));
      r.total_paye = Math.min(money(r.total_paye), r.total_attendu);
      r.solde = money(r.total_attendu - r.total_paye);
      r.paiement_controle = r.total_attendu > 0 && r.total_paye >= r.total_attendu ? true : !!r.paiement_controle;
      r.statut = r.solde <= 0 && r.total_attendu > 0 ? "Paye" : "A suivre";
    }
    if (table === "remuneration_gerant") {
      r.annee = Number(r.annee || String(r.mois || "").slice(0, 4) || state.year);
      r.remuneration_brute_7pc = round2((Number(r.encaissements_ht) || 0) * 0.07);
      r.remuneration_apres_abattement = round2((Number(r.encaissements_ht) || 0) * 0.07 * 0.70);
      r.frais_km = round2((Number(r.km) || 0) * (Number(r.bareme_km) || 0.636));
      r.total_compte_courant = round2(
        (Number(r.encaissements_ht) || 0) * 0.07 * 0.70 +
        (Number(r.km) || 0) * (Number(r.bareme_km) || 0.636) +
        (Number(r.prime_edl) || 0) +
        (Number(r.prime_responsabilite) || 0) +
        (r.autres_frais_inclus_total ? (Number(r.autres_frais) || 0) : 0)
      );
    }
    return r;
  }

  function round2(v) {
    return Math.round((Number(v) || 0) * 100) / 100;
  }

  function money(v) {
    return Math.max(0, round2(v));
  }

  async function dbList(table) {
    if (!sb) {
      const rows = localRead(table).map((r) => withComputed(table, r));
      return table === "locaux" ? rows.filter((r) => r.actif !== false) : rows;
    }
    const { data, error } = await sb.from(table).select("*").order("created_at", { ascending: true });
    if (error) throw error;
    const rows = data || [];
    return table === "locaux" ? rows.filter((r) => r.actif !== false) : rows;
  }

  async function dbSave(table, payload) {
    if (!state.isAdmin) throw new Error("Lecture seule: modification non autorisee.");
    const row = withComputed(table, { ...payload });
    if (!sb) {
      const rows = localRead(table);
      if (row.id) {
        const idx = rows.findIndex((x) => x.id === row.id);
        if (idx >= 0) rows[idx] = { ...rows[idx], ...row, updated_at: new Date().toISOString() };
        else rows.push({ ...row, id: row.id || uid(), created_at: new Date().toISOString(), updated_at: new Date().toISOString() });
      } else {
        rows.push({ ...row, id: uid(), created_at: new Date().toISOString(), updated_at: new Date().toISOString() });
      }
      localWrite(table, rows);
      return row;
    }
    const clean = stripGenerated(table, row);
    const q = row.id
      ? sb.from(table).update(clean).eq("id", row.id).select().single()
      : sb.from(table).insert(clean).select().single();
    const { data, error } = await q;
    if (error) throw error;
    return data;
  }

  async function dbDelete(table, id, message) {
    if (!state.isAdmin) {
      toast("Lecture seule: suppression non autorisee.");
      return;
    }
    if (!confirm(message || "Supprimer cette ligne ?")) return false;
    if (!sb) {
      localWrite(table, localRead(table).filter((r) => r.id !== id));
      return true;
    }
    const { error } = await sb.from(table).delete().eq("id", id);
    if (error) throw error;
    return true;
  }

  function stripGenerated(table, row) {
    const r = { ...row };
    if (!r.id) delete r.id;
    delete r.created_at;
    delete r.updated_at;
    if (table === "loyers_mensuels") delete r.solde;
    if (table === "remuneration_gerant") {
      delete r.remuneration_brute_7pc;
      delete r.remuneration_apres_abattement;
      delete r.frais_km;
      delete r.total_compte_courant;
    }
    return r;
  }

  async function loadAll() {
    for (const table of tables) state.data[table] = await dbList(table);
  }

  async function loadCurrentProfile() {
    if (!sb || state.localMode) {
      state.profile = {
        email: state.user ? state.user.email : (cfg.adminEmail || "local"),
        nom: "Michel Bidal",
        role: "admin",
        actif: true
      };
      state.isAdmin = true;
      return;
    }

    const email = String(state.user ? state.user.email : "").toLowerCase();
    const { data, error } = await sb
      .from("app_users")
      .select("email,nom,role,actif")
      .eq("email", email)
      .maybeSingle();
    if (error) throw error;
    if (!data || !data.actif) throw new Error("Acces non autorise pour ce compte.");
    state.profile = data;
    state.isAdmin = data.role === "admin";
  }

  function updateUserChrome() {
    const name = state.profile ? state.profile.nom : "Utilisateur";
    const role = state.isAdmin ? "Administrateur" : "Lecture seule";
    const nameEl = $("#sidebar-user-name");
    const roleEl = $("#sidebar-user-role");
    if (nameEl) nameEl.textContent = name;
    if (roleEl) roleEl.textContent = role;
  }

  function adminHtml(html) {
    return state.isAdmin ? html : "";
  }

  function ensureAdminAction() {
    if (state.isAdmin) return true;
    toast("Lecture seule: action non autorisee.");
    return false;
  }

  function localLabel(table, id) {
    const row = (state.data[table] || []).find((x) => x.id === id);
    if (!row) return "";
    if (table === "locaux") return row.code_local || row.designation || "";
    if (table === "locataires") return row.raison_sociale || `${row.nom || ""} ${row.prenom || ""}`.trim();
    return row.id || "";
  }

  function tenantById(id) {
    return (state.data.locataires || []).find((tenant) => tenant.id === id) || null;
  }

  function phoneDialValue(value) {
    return String(value || "").trim().replace(/[^\d+]/g, "");
  }

  function bailTenantOptions(emptyLabel) {
    return [{ value: "", label: emptyLabel || "-" }].concat(
      (state.data.locataires || []).map((tenant) => {
        const phone = String(tenant.telephone || "").trim();
        return {
          value: tenant.id,
          label: `${localLabel("locataires", tenant.id)}${phone ? ` - ${phone}` : ""}`
        };
      })
    );
  }

  function initInstall() {
    window.addEventListener("beforeinstallprompt", (e) => {
      e.preventDefault();
      state.installPrompt = e;
      $("#install-btn").hidden = false;
    });
    $("#install-btn").addEventListener("click", async () => {
      if (state.installPrompt) {
        state.installPrompt.prompt();
        state.installPrompt = null;
      } else {
        openModal("Installer sur telephone", `
          <div class="notice info">
            iPhone : bouton Partager de Safari, puis Sur l'ecran d'accueil.<br>
            Android : menu Chrome, puis Ajouter a l'ecran d'accueil.
          </div>
        `);
      }
    });
    if ("serviceWorker" in navigator) navigator.serviceWorker.register("./service-worker.js").catch(() => {});
  }

  function initAuth() {
    $("#config-warning").hidden = hasConfig;
    $("#magic-link-btn").hidden = !hasConfig;
    $("#local-preview-btn").hidden = hasConfig;

    $("#login-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      if (!sb) return showLoginMessage("La base en ligne n'est pas encore configuree. Utilisez le mode apercu local.");
      try {
        const email = $("#login-email").value.trim();
        const password = $("#login-password").value;
        const { data, error } = await sb.auth.signInWithPassword({ email, password });
        if (error) throw error;
        state.user = data.user;
        await startApp();
      } catch (err) {
        showLoginMessage(err.message || String(err));
      }
    });

    $("#magic-link-btn").addEventListener("click", async () => {
      try {
        const email = $("#login-email").value.trim();
        const { error } = await sb.auth.signInWithOtp({
          email,
          options: { emailRedirectTo: `${window.location.origin}${window.location.pathname}` }
        });
        if (error) throw error;
        showLoginMessage("Lien envoye. Regardez votre boite mail.");
      } catch (err) {
        showLoginMessage(err.message || String(err));
      }
    });

    $("#local-preview-btn").addEventListener("click", async () => {
      state.user = { email: cfg.adminEmail || "local" };
      state.localMode = true;
      seedLocalIfEmpty();
      await startApp();
    });
  }

  async function initSession() {
    if (!sb) return;
    const qs = new URLSearchParams(window.location.search);
    if (qs.has("code")) {
      const { error } = await sb.auth.exchangeCodeForSession(window.location.href);
      if (error) throw error;
      window.history.replaceState({}, document.title, window.location.pathname);
    } else if (window.location.hash.includes("access_token")) {
      window.history.replaceState({}, document.title, window.location.pathname);
    }

    const { data, error } = await sb.auth.getSession();
    if (error) throw error;
    if (data.session && data.session.user) {
      state.user = data.session.user;
      await startApp();
    }
  }

  async function startApp() {
    $("#login").hidden = true;
    $("#app").hidden = false;
    await loadCurrentProfile();
    updateUserChrome();
    await loadAll();
    setupNav();
    render();
    notifyDeadlines();
  }

  function showLoginMessage(msg) {
    $("#login-message").textContent = msg;
  }

  function setupNav() {
    document.querySelectorAll(".app-nav button").forEach((btn) => {
      btn.addEventListener("click", () => App.go(btn.dataset.route));
    });
  }

  function setTitle(title) {
    $("#screen-title").textContent = title;
    document.querySelectorAll(".app-nav button").forEach((btn) => btn.classList.toggle("active", btn.dataset.route === state.route));
  }

  function render() {
    const screen = $("#screen");
    if (state.route === "dashboard") screen.innerHTML = renderDashboard();
    if (state.route === "pointage") screen.innerHTML = renderPointage();
    if (state.route === "locaux") screen.innerHTML = renderLocaux();
    if (state.route === "locataires") screen.innerHTML = renderLocataires();
    if (state.route === "baux") screen.innerHTML = renderBaux();
    if (state.route === "travaux") screen.innerHTML = renderTravauxScreen();
    if (state.route === "entretien") screen.innerHTML = renderEntretien();
    if (state.route === "etudes") screen.innerHTML = renderEtudes();
    if (state.route === "remuneration") screen.innerHTML = renderRemunerationScreen();
    if (state.route === "comptes-rendus") screen.innerHTML = renderReports();
    if (state.route === "energie") { setTitle("Dépenses énergie"); screen.innerHTML = renderAnnualLedger("energie"); }
    if (state.route === "plus") screen.innerHTML = renderPlus();
  }

  function getMonthRows() {
    return state.data.loyers_mensuels.filter((l) => String(l.mois || "").slice(0, 7) === state.month);
  }

  function activeBaux() {
    const firstDay = monthDate(state.month);
    const lastDay = monthEndDate(state.month);
    return state.data.baux.filter((b) =>
      b.statut === "Actif" &&
      !isSecondaryBail(b) &&
      b.date_debut <= lastDay &&
      (!b.date_fin || b.date_fin >= firstDay)
    );
  }

  function isSecondaryBail(b) {
    return String((b && b.observations) || "").includes("[LOCAL_SECONDAIRE]");
  }

  function leaseDeadlineInfo(b) {
    if (!b || b.statut !== "Actif" || !b.date_fin || isSecondaryBail(b)) return null;
    const days = daysUntil(b.date_fin);
    if (days < 0) return { level: "expired", label: "Echu", days };
    if (days <= 92) return { level: "three", label: "Moins de 3 mois", days };
    if (days <= 183) return { level: "six", label: "Entre 3 et 6 mois", days };
    return null;
  }

  function expiringBaux() {
    return state.data.baux
      .map((b) => ({ ...b, _deadline: leaseDeadlineInfo(b) }))
      .filter((b) => b._deadline)
      .sort((a, b) => String(a.date_fin).localeCompare(String(b.date_fin)));
  }

  function renderDashboard() {
    setTitle("Tableau de bord");
    const rows = getMonthRows();
    const expected = sum(rows, "total_attendu");
    const paid = sum(rows, "total_paye");
    const solde = Math.max(0, round2(expected - paid));
    const megDone = rows.filter((r) => r.facture_meg_faite).length;
    const payDone = rows.filter((r) => r.paiement_controle).length;
    const taux = expected ? Math.min(100, Math.round((paid / expected) * 100)) : 0;
    const baux = expiringBaux();
    const bauxUrgents = baux.filter((b) => b._deadline.level === "expired" || b._deadline.level === "three");
    const bauxSixMois = baux.filter((b) => b._deadline.level === "six");
    return `
      <div class="desktop-wrap grid">
        ${state.localMode ? `<div class="notice warning">Mode apercu local : les donnees restent sur cet appareil tant que la base en ligne n'est pas configuree.</div>` : ""}
        ${bauxUrgents.length ? `<div class="notice danger"><strong>${bauxUrgents.length} bail(s) urgent(s)</strong><br>Echeance depassee ou dans moins de 3 mois.</div>` : ""}
        ${bauxSixMois.length ? `<div class="notice warning"><strong>${bauxSixMois.length} bail(s) a anticiper</strong><br>Echeance comprise entre 3 et 6 mois.</div>` : ""}
        <div class="toolbar">
          <input type="month" value="${state.month}" onchange="App.setMonth(this.value)">
          ${adminHtml(`<button class="secondary" onclick="App.generateRents()">Preparer le mois</button>`)}
        </div>
        <div class="cards">
          <div class="card orange"><small>Factures MEG</small><strong>${megDone}/${rows.length}</strong></div>
          <div class="card green"><small>Loyers payes</small><strong>${euro(paid)}</strong></div>
          <div class="card red"><small>Reste a suivre</small><strong>${euro(solde)}</strong></div>
          <div class="card red"><small>Baux &lt; 3 mois</small><strong>${bauxUrgents.length}</strong></div>
          <div class="card orange"><small>Baux de 3 a 6 mois</small><strong>${bauxSixMois.length}</strong></div>
        </div>
        <div class="panel">
          <div class="panel-head"><h3>Avancement paiements</h3><strong>${taux}%</strong></div>
          <div class="progress"><div style="width:${taux}%"></div></div>
          <div class="chips" style="margin-top:12px">
            <span class="chip">${euro(expected)} attendu</span>
            <span class="chip green">${payDone} paiement(s) pointes</span>
          </div>
        </div>
        <div class="panel">
          <div class="panel-head"><h3>Routine MEG</h3></div>
          <div class="notice info">1. Je fais la facture dans MEG. 2. Je coche MEG ici. 3. Quand le virement arrive, je coche Paye.</div>
          <button class="primary" onclick="App.go('pointage')">Ouvrir le pointage</button>
        </div>
        ${renderBauxAlertPanel(baux)}
      </div>
    `;
  }

  function renderBauxAlertPanel(rows) {
    if (!rows.length) return "";
    return `
      <div class="panel">
        <div class="panel-head"><h3>Baux a echeance</h3><button class="secondary" onclick="App.requestNotifications()">Notifications</button></div>
        <div class="list">${rows.map((b) => `
          <div class="row">
            <div class="row-main">
              <div><div class="row-title">${escapeHtml(localLabel("locataires", b.locataire_id))}</div>
              <div class="row-sub">${escapeHtml(localLabel("locaux", b.local_id))} - fin ${fmtDate(b.date_fin)}</div></div>
              <span class="chip ${b._deadline.level === "six" ? "orange" : "red"}">${b._deadline.days < 0 ? `${Math.abs(b._deadline.days)} j de retard` : `${b._deadline.days} j`}</span>
            </div>
            <div class="chips"><span class="chip ${b._deadline.level === "six" ? "orange" : "red"}">${escapeHtml(b._deadline.label)}</span>${b.renouvellement_auto ? `<span class="chip green">Renouvellement auto</span>` : ""}</div>
          </div>`).join("")}</div>
      </div>`;
  }

  function renderPointage() {
    setTitle("Pointage MEG");
    const rows = getMonthRows().sort((a, b) => pointageLabel(a).localeCompare(pointageLabel(b)));
    return `
      <div class="desktop-wrap">
        <div class="toolbar">
          <input type="month" value="${state.month}" onchange="App.setMonth(this.value)">
          ${adminHtml(`<button class="primary" onclick="App.generateRents()">Generer</button>`)}
        </div>
        <div class="panel">
          <div class="panel-head"><h3>${rows.length} ligne(s) du mois</h3>${adminHtml(`<button class="secondary" onclick="App.openLoyer()">Ajouter</button>`)}</div>
          <div class="list">${rows.length ? rows.map(renderLoyerRow).join("") : `<div class="empty">Aucun loyer pour ce mois. Utilisez Generer.</div>`}</div>
        </div>
      </div>
    `;
  }

  function pointageLabel(row) {
    return localLabel("locataires", row.locataire_id) || row.observations || "Ligne manuelle";
  }

  function renderLoyerRow(l) {
    const locataire = pointageLabel(l);
    const local = localLabel("locaux", l.local_id);
    const paidFull = Number(l.total_paye || 0) >= Number(l.total_attendu || 0) && Number(l.total_attendu || 0) > 0;
    return `
      <div class="row">
        <div class="row-main">
          <div>
            <div class="row-title">${escapeHtml(locataire)}</div>
            <div class="row-sub">${escapeHtml(local)} - HT ${euro(l.loyer_ht)} - charges ${euro(l.charges_mensuelles)}</div>
          </div>
          <div class="row-amount">${euro(l.total_attendu)}<div class="row-sub">paye ${euro(l.total_paye)}</div></div>
        </div>
        ${state.isAdmin ? `<div class="check-line">
          <button class="check-pill ${l.facture_meg_faite ? "done" : ""}" onclick="App.toggleLoyer('${l.id}','facture_meg_faite')">MEG</button>
          <button class="check-pill ${l.paiement_controle ? "done" : ""}" onclick="App.toggleLoyer('${l.id}','paiement_controle')">${paidFull ? "Paye 100%" : "Paye"}</button>
        </div>` : `<div class="chips"><span class="chip ${l.facture_meg_faite ? "green" : ""}">MEG ${l.facture_meg_faite ? "fait" : "a faire"}</span><span class="chip ${l.paiement_controle ? "green" : "orange"}">${l.paiement_controle ? "Paye" : "A suivre"}</span></div>`}
        ${adminHtml(`<div class="actions">
          <button onclick="App.openLoyer('${l.id}')">Modifier</button>
          <button class="danger" onclick="App.deleteRow('loyers_mensuels','${l.id}')">Supprimer</button>
        </div>`)}
      </div>`;
  }

  function renderBaux() {
    setTitle("Baux");
    const rows = [...state.data.baux].sort((a, b) => String(a.date_fin || "9999").localeCompare(String(b.date_fin || "9999")));
    return `
      <div class="desktop-wrap">
        <div class="panel">
          <div class="panel-head"><h3>Baux</h3>${adminHtml(`<button class="primary" onclick="App.openBail()">Ajouter</button>`)}</div>
          <div class="list">${rows.length ? rows.map((b) => {
            const tenant = tenantById(b.locataire_id);
            const hasPdf = Boolean(leaseDocumentId(b));
            const phone = String(tenant && tenant.telephone || "").trim();
            const phoneHtml = phone
              ? `<a class="phone-link" href="tel:${escapeHtml(phoneDialValue(phone))}">Tel. ${escapeHtml(phone)}</a>`
              : `<span class="muted">Telephone non renseigne</span>`;
            return `
              <div class="row">
                <div class="row-main">
                  <div><div class="row-title">${escapeHtml(localLabel("locataires", b.locataire_id))}</div>
                  <div class="row-sub">${escapeHtml(localLabel("locaux", b.local_id))} - ${fmtDate(b.date_debut)} au ${fmtDate(b.date_fin)}</div>
                  <div class="row-contact">${phoneHtml}</div></div>
                  <span class="chip ${leaseChipClass(b)}">${escapeHtml(b.statut)}</span>
                </div>
                <div class="chips"><span class="chip green">Total TTC ${euro(loyerFromBail(b.id).total_attendu)}</span><span class="chip">Loyer TTC ${euro(loyerFromBail(b.id).loyer_ttc)}</span><span class="chip">Charges ${euro(b.charges_mensuelles)}</span><span class="chip">HT ${euro(b.loyer_ht)}</span>${isSecondaryBail(b) ? `<span class="chip">Local associe</span>` : ""}${b.renouvellement_auto ? `<span class="chip green">Renouv. auto</span>` : ""}</div>
                <div class="actions">${hasPdf ? `<button onclick="App.downloadLease('${b.id}',this)">Télécharger le bail</button>` : ""}${adminHtml(`<button onclick="App.openBail('${b.id}')">Modifier</button>`)}</div>
              </div>`;
          }).join("") : `<div class="empty">Aucun bail</div>`}</div>
        </div>
      </div>`;
  }

  function leaseChipClass(b) {
    const info = leaseDeadlineInfo(b);
    if (!info) return b.statut === "Actif" ? "green" : "";
    return info.level === "six" ? "orange" : "red";
  }

  function localMonthlyTotal(local) {
    return money((Number(local.loyer_ttc) || Number(local.loyer_ht) || 0) + (Number(local.charges_mensuelles) || 0));
  }

  function tenantLeaseSummary(locataireId) {
    const rows = state.data.baux.filter((b) => b.locataire_id === locataireId && !["Archive", "Resilie"].includes(b.statut));
    const primary = rows.filter((b) => !isSecondaryBail(b));
    const amountRows = primary.length ? primary : rows;
    const localIds = [...new Set(rows.map((b) => b.local_id).filter(Boolean))];
    const datesDebut = rows.map((b) => b.date_debut).filter(Boolean).sort();
    const datesFin = rows.map((b) => b.date_fin).filter(Boolean).sort();
    return {
      rows,
      locaux: localIds.map((id) => localLabel("locaux", id)).filter(Boolean),
      dateDebut: datesDebut[0] || "",
      dateFin: datesFin[datesFin.length - 1] || "",
      loyerHt: sum(amountRows, "loyer_ht"),
      loyerTtc: round2(amountRows.reduce((total, b) => total + loyerFromBail(b.id).loyer_ttc, 0)),
      charges: sum(amountRows, "charges_mensuelles"),
      renouvellementAuto: rows.some((b) => b.renouvellement_auto)
    };
  }

  function renderLocaux() {
    setTitle("Locaux");
    const rows = [...state.data.locaux].sort((a, b) => String(a.code_local || "").localeCompare(String(b.code_local || ""), "fr", { numeric: true }));
    return `
      <div class="desktop-wrap">
        <div class="panel">
          <div class="panel-head"><h3>${rows.length} locaux et emplacements</h3>${adminHtml(`<button class="primary" onclick="App.openLocal()">Ajouter</button>`)}</div>
          <div class="table-wrap desktop-table">
            <table class="data-table">
              <thead><tr><th>Numero</th><th>Designation</th><th>Niveau</th><th>Surface</th><th>Statut</th><th class="num">Loyer HT</th><th class="num">Charges</th><th class="num">Total</th><th></th></tr></thead>
              <tbody>${rows.map((l) => `<tr>
                <td><strong>${escapeHtml(l.code_local)}</strong></td>
                <td>${escapeHtml(l.designation || "")}</td>
                <td>${escapeHtml(l.niveau || "")}</td>
                <td>${Number(l.surface_m2 || 0).toFixed(2)} m2</td>
                <td><span class="chip ${l.statut === "Loue" ? "green" : l.statut === "Disponible" ? "orange" : ""}">${escapeHtml(l.statut)}</span></td>
                <td class="num">${euro(l.loyer_ht)}</td><td class="num">${euro(l.charges_mensuelles)}</td><td class="num"><strong>${euro(localMonthlyTotal(l))}</strong></td>
                <td>${adminHtml(`<button class="table-action" onclick="App.openLocal('${l.id}')">Modifier</button>`)}</td>
              </tr>`).join("")}</tbody>
            </table>
          </div>
          <div class="list mobile-list">${rows.length ? rows.map((l) => `
            <div class="row">
              <div class="row-main"><div><div class="row-title">${escapeHtml(l.code_local)} - ${escapeHtml(l.designation)}</div><div class="row-sub">${escapeHtml(l.niveau || "")} - ${Number(l.surface_m2 || 0).toFixed(2)} m2</div></div><span class="chip ${l.statut === "Loue" ? "green" : "orange"}">${escapeHtml(l.statut)}</span></div>
              <div class="chips"><span class="chip">HT ${euro(l.loyer_ht)}</span><span class="chip">Charges ${euro(l.charges_mensuelles)}</span><span class="chip green">Total ${euro(localMonthlyTotal(l))}</span></div>
              ${adminHtml(`<div class="actions"><button onclick="App.openLocal('${l.id}')">Modifier</button></div>`)}
            </div>`).join("") : `<div class="empty">Aucun local</div>`}</div>
        </div>
      </div>`;
  }

  function renderLocataires() {
    setTitle("Locataires");
    const rows = [...state.data.locataires].sort((a, b) => localLabel("locataires", a.id).localeCompare(localLabel("locataires", b.id), "fr"));
    const summaries = new Map(rows.map((l) => [l.id, tenantLeaseSummary(l.id)]));
    return `
      <div class="desktop-wrap">
        <div class="panel">
          <div class="panel-head"><h3>${rows.length} locataires</h3>${adminHtml(`<button class="primary" onclick="App.openLocataire()">Ajouter</button>`)}</div>
          <div class="table-wrap desktop-table">
            <table class="data-table">
              <thead><tr><th>Locataire</th><th>Local(aux)</th><th>Debut du bail</th><th>Fin du bail</th><th class="num">Loyer HT</th><th class="num">Charges</th><th class="num">Total mensuel</th><th></th></tr></thead>
              <tbody>${rows.map((l) => {
                const s = summaries.get(l.id);
                return `<tr>
                  <td><strong>${escapeHtml(localLabel("locataires", l.id))}</strong><div class="table-sub">${escapeHtml(l.email || l.telephone || "")}</div></td>
                  <td>${s.locaux.length ? s.locaux.map((x) => `<span class="chip">${escapeHtml(x)}</span>`).join(" ") : `<span class="muted">Non associe</span>`}</td>
                  <td>${fmtDate(s.dateDebut) || "-"}</td><td>${fmtDate(s.dateFin) || "-"}${s.renouvellementAuto ? `<div class="table-sub">Renouvellement auto</div>` : ""}</td>
                  <td class="num">${euro(s.loyerHt)}</td><td class="num">${euro(s.charges)}</td><td class="num"><strong>${euro(s.loyerTtc + s.charges)}</strong></td>
                  <td>${adminHtml(`<button class="table-action" onclick="App.openLocataire('${l.id}')">Modifier</button>`)}</td>
                </tr>`;
              }).join("")}</tbody>
            </table>
          </div>
          <div class="list mobile-list">${rows.length ? rows.map((l) => {
            const s = summaries.get(l.id);
            return `<div class="row">
              <div class="row-main"><div><div class="row-title">${escapeHtml(localLabel("locataires", l.id))}</div><div class="row-sub">${s.locaux.length ? escapeHtml(s.locaux.join(" + ")) : "Aucun local associe"}</div></div><div class="row-amount">${euro(s.loyerTtc + s.charges)}</div></div>
              <div class="chips"><span class="chip">HT ${euro(s.loyerHt)}</span><span class="chip">Charges ${euro(s.charges)}</span>${s.renouvellementAuto ? `<span class="chip green">Renouv. auto</span>` : ""}</div>
              <div class="row-sub">Bail : ${fmtDate(s.dateDebut) || "-"} au ${fmtDate(s.dateFin) || "-"}</div>
              ${adminHtml(`<div class="actions"><button onclick="App.openLocataire('${l.id}')">Modifier</button></div>`)}
            </div>`;
          }).join("") : `<div class="empty">Aucun locataire</div>`}</div>
        </div>
      </div>`;
  }

  async function dbDocumentMetadata(categories) {
    if (!sb) return localRead("documents").filter(r => categories.includes(r.categorie)).map(({url, ...row}) => row);
    const fields = "id,nom_fichier,categorie,observations,created_at";
    const {data,error} = await sb.from("documents").select(fields).in("categorie",categories).order("created_at",{ascending:false});
    if (error) throw error;
    return data || [];
  }

  async function loadReportRecords() {
    state.reportsLoading = true;
    state.reportsError = "";
    if (state.route === "comptes-rendus") render();
    try {
      state.reportRecords = await dbDocumentMetadata([REPORT_CATEGORY,REPORT_NOTE_CATEGORY]);
    } catch (error) {
      state.reportsError = "Impossible de charger les comptes rendus : " + (error.message || error);
    } finally {
      state.reportsLoading = false;
      if (state.route === "comptes-rendus") render();
    }
  }

  function reportDetails(row) {
    try { return JSON.parse(row.observations || "{}") || {}; }
    catch (error) { return {}; }
  }

  function annualLedgerConfig(kind) {
    if (kind === "entretien") return {category:MAINTENANCE_BUDGET_CATEGORY,title:"Budget annuel d’entretien",unit:"€ HT",yearLabel:"Année entretien",posts:Object.entries(entretienCategories).map(([key,label])=>[key,label,""])};
    const record = state.annualLedgers.energie.records.find(r=>r.categorie===ENERGY_METERS_CATEGORY);
    const meters = record ? reportDetails(record).compteurs : {};
    const posts = ENERGY_POSTS.map(([key,title,detail])=>{
      const number = String(meters?.[key] || "");
      return [key,title,/^\d{6,18}$/.test(number) ? `${detail} · Compteur n° ${number}` : detail];
    });
    return {category:ENERGY_CATEGORY,title:"Dépenses énergie",unit:"€ TTC",yearLabel:"Année énergie",posts};
  }

  async function loadAnnualRecords(kind) {
    const ledger = state.annualLedgers[kind];
    ledger.loading = true;
    ledger.error = "";
    if (state.route === kind) render();
    try {
      const categories = [annualLedgerConfig(kind).category];
      if (kind === "energie") categories.push(ENERGY_METERS_CATEGORY);
      ledger.records = await dbDocumentMetadata(categories);
    } catch (error) {
      ledger.error = "Impossible de charger les dépenses : " + (error.message || error);
    } finally {
      ledger.loading = false;
      if (state.route === kind) render();
    }
  }

  function annualByYear(kind, records = state.annualLedgers[kind].records) {
    const byYear = kind === "entretien" ? entretienAnnualDefaults() : new Map();
    for (const record of records) {
      const details = reportDetails(record);
      const year = Number(details.annee);
      if (Number.isInteger(year) && year >= 2000 && year <= 2100 && !byYear.get(year)?.id) {
        const savedPosts = details.postes || {};
        byYear.set(year,{id:record.id,savedPosts,posts:{...byYear.get(year)?.posts,...savedPosts}});
      }
    }
    return byYear;
  }

  function maintenanceTtc(ht, recordedTtc) {
    if (ht == null) return null;
    return Number.isFinite(recordedTtc) ? recordedTtc : Math.round(Math.round(ht*100)*6/5)/100;
  }

  function renderAnnualLedger(kind) {
    const ledger = state.annualLedgers[kind];
    const config = annualLedgerConfig(kind);
    if (ledger.loading) return '<div class="empty">Chargement des dépenses…</div>';
    if (ledger.error) return `<div class="notice danger">${escapeHtml(ledger.error)}</div><button class="secondary" onclick="App.go('${kind}')">Réessayer</button>`;
    const records = annualByYear(kind);
    const years = [...records.keys()].sort((a,b)=>b-a);
    const year = records.has(Number(ledger.year)) ? Number(ledger.year) : years[0];
    const current = records.get(year);
    const previous = records.get(year-1);
    const format = new Intl.NumberFormat("fr-FR",{style:"currency",currency:"EUR"});
    const dual = kind === "entretien";
    const display = (amount,suffix="") => amount == null ? "—" : format.format(amount)+suffix;
    const amount = (record,key,kind) => {
      const value = record?.posts[key]?.[kind];
      return typeof value === "number" && Number.isFinite(value) ? value : null;
    };
    const periods = [[previous,"reel"],[current,"prevision"],[current,"reel"]];
    const rows = config.posts.map(([key,title,detail])=>{
      const values = periods.map(([record,field])=>amount(record,key,field));
      const ttc = periods.map(([record,field],index)=>maintenanceTtc(values[index],amount(record,key,field+"_ttc")));
      return {key,title,detail,values,ttc};
    });
    const totalFor = field => [0,1,2].map(index => rows.some(r=>r[field][index] !== null) ? round2(rows.reduce((s,r)=>s+(r[field][index] ?? 0),0)) : null);
    const totals = {values:totalFor("values"),ttc:totalFor("ttc")};
    const headings = [`Réel ${year-1}`,`Prévision ${year}`,`Réel ${year}`];
    const columns = headings.flatMap(h=>dual ? [h+" HT",h+" TTC"] : [h+" TTC"]);
    const valueCells = ({values,ttc},tag="td") => values.flatMap((v,i)=>dual ? [v,ttc[i]] : [v]).map(v=>`<${tag} class="num">${display(v)}</${tag}>`).join("");
    const mobileValues = ({values,ttc}) => `<div class="works-amounts">${values.map((value,index)=>`<span>${headings[index]}${dual?"":" TTC"}<b>${display(value,dual?" HT":"")}</b>${dual && value!==null?`<b>${display(ttc[index]," TTC")}</b>`:""}</span>`).join("")}</div>`;
    const postAction = row => {
      const label = row.values[2] === null ? "Saisir le réel" : "Modifier";
      return `<button class="table-action" aria-label="${label} : ${row.title}" onclick="App.openAnnualForm('${kind}',${year},'${row.key}')">${label}</button>`;
    };
    return `<section class="${kind==="energie"?"desktop-wrap":""} panel works-panel annual-ledger ${kind==="entretien"?"entretien-budget":""}">
      <div class="panel-head"><div><h3>${config.title}</h3><div class="table-sub">${dual?"HT et TTC · TVA 20 %":"Montants TTC"}</div></div>${adminHtml(`<button class="primary" onclick="App.openAnnualForm('${kind}')">Ajouter une année</button>`)}</div>
      ${current ? `
      <div class="toolbar"><select aria-label="${config.yearLabel}" onchange="App.setAnnualYear('${kind}',this.value)">${years.map(y=>`<option value="${y}" ${y===year?"selected":""}>${y}</option>`).join("")}</select>
      ${adminHtml(`<button class="secondary" onclick="App.openAnnualForm('${kind}',${year})">Modifier ${year}</button>`)}</div>
      <div class="table-wrap desktop-table"><table class="data-table energy-table"><thead><tr><th>Poste</th>${columns.map(h=>`<th class="num">${h}</th>`).join("")}${adminHtml("<th>Action</th>")}</tr></thead>
      <tbody>${rows.map(r=>`<tr><td><strong>${r.title}</strong>${r.detail ? `<div class="table-sub">${r.detail}</div>` : ""}</td>${valueCells(r)}${adminHtml(`<td>${postAction(r)}</td>`)}</tr>`).join("")}</tbody>
      <tfoot><tr><th>Total</th>${valueCells(totals,"th")}${adminHtml("<td></td>")}</tr></tfoot></table></div>
      <div class="list mobile-list"><div class="row"><strong>Total</strong>${mobileValues(totals)}</div>${rows.map(r=>`<div class="row"><div><strong>${r.title}</strong>${r.detail ? `<div class="table-sub">${r.detail}</div>` : ""}</div>${mobileValues(r)}${adminHtml(`<div class="actions">${postAction(r)}</div>`)}</div>`).join("")}</div>
      ` : '<div class="empty">Aucune dépense enregistrée</div>'}
    </section>`;
  }

  function findReport(id) {
    return state.reportRecords.find(r => r.id === id && r.categorie === REPORT_CATEGORY);
  }

  function renderReports() {
    setTitle("Comptes rendus");
    const rows = state.reportRecords.filter(r => r.categorie === REPORT_CATEGORY)
      .sort((a,b) => String(reportDetails(b).date || "").localeCompare(String(reportDetails(a).date || "")));
    const report = findReport(state.reportId);
    if (state.reportsLoading) return '<div class="empty">Chargement des comptes rendus…</div>';
    if (state.reportsError) return `<div class="notice danger">${escapeHtml(state.reportsError)}</div><button class="secondary" onclick="App.go('comptes-rendus')">Réessayer</button>`;
    if (!report) return `<section class="desktop-wrap panel reports-panel">
      <div class="panel-head"><h3>Comptes rendus</h3>${adminHtml('<button class="primary" onclick="App.openReportForm()">Ajouter un compte rendu</button>')}</div>
      <div class="list">${rows.length ? rows.map(r => {
        const d = reportDetails(r);
        const count = state.reportRecords.filter(n => n.categorie === REPORT_NOTE_CATEGORY && reportDetails(n).report_id === r.id).length;
        return `<button class="report-row" onclick="App.viewReport('${escapeHtml(r.id)}')"><span><strong>${escapeHtml(d.title || r.nom_fichier)}</strong><small>${escapeHtml(fmtDate(d.date))} · PDF</small></span><span class="report-count">${count} annotation${count===1?"":"s"} <b aria-hidden="true">›</b></span></button>`;
      }).join("") : '<div class="empty">Aucun compte rendu</div>'}</div>
    </section>`;
    const d = reportDetails(report);
    const id = escapeHtml(report.id);
    const notes = state.reportRecords.filter(n => n.categorie === REPORT_NOTE_CATEGORY && reportDetails(n).report_id === report.id).sort((a,b) => String(b.created_at).localeCompare(String(a.created_at)));
    return `<div class="desktop-wrap">
      <button class="table-action" onclick="App.viewReport('')">← Comptes rendus</button>
      <section class="panel reports-panel">
        <div class="panel-head"><div><h3>${escapeHtml(d.title || report.nom_fichier)}</h3><div class="table-sub">${escapeHtml(fmtDate(d.date))} · PDF</div></div><button class="secondary" onclick="App.downloadReport('${id}',this)">Télécharger le PDF</button></div>
      </section>
      <section class="panel reports-panel">
        <div class="panel-head"><h3>Annotations</h3>${adminHtml(`<button class="primary" onclick="App.openReportNote('${id}')">Ajouter une annotation</button>`)}</div>
        <div class="list">${notes.length ? notes.map(n => {
          const note = reportDetails(n);
          return `<article class="report-note"><div class="table-sub">${escapeHtml(note.author || "")} · ${escapeHtml(fmtDate(n.created_at))}</div><p>${escapeHtml(note.text)}</p></article>`;
        }).join("") : '<div class="empty">Aucune annotation</div>'}</div>
      </section>
    </div>`;
  }

  async function readReportPdf(file) {
    if (!file || file.size > REPORT_MAX_BYTES || await file.slice(0,5).text() !== "%PDF-") {
      throw new Error("Choisissez un fichier PDF de 3 Mo maximum.");
    }
    return new Promise((resolve,reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error("Impossible de lire le PDF."));
      reader.readAsDataURL(new Blob([file], {type:"application/pdf"}));
    });
  }

  function leaseDocumentId(bail) {
    return /^document:([a-f0-9-]{36})$/i.exec(String(bail.document_url || ""))?.[1] || "";
  }

  async function downloadStoredPdf({id, category, bailId, maxBytes}, button) {
    if (!id || !state.profile?.actif || button.disabled) return;
    button.disabled = true;
    try {
      let doc;
      if (sb) {
        let query = sb.from("documents").select("url,nom_fichier").eq("id",id).eq("categorie",category);
        if (bailId) query = query.eq("bail_id",bailId);
        const {data,error} = await query.single();
        if (error) throw error;
        doc = data;
      } else {
        doc = localRead("documents").find(r => r.id === id && r.categorie === category && (!bailId || r.bail_id === bailId));
      }
      const value = doc?.url;
      if (!value?.startsWith(PDF_DATA_PREFIX) || value.length > 4 * Math.ceil(maxBytes / 3) + PDF_DATA_PREFIX.length) throw new Error("PDF indisponible.");
      const binary = atob(value.slice(PDF_DATA_PREFIX.length));
      if (!binary.startsWith("%PDF-") || binary.length > maxBytes) throw new Error("PDF invalide.");
      const href = URL.createObjectURL(new Blob([Uint8Array.from(binary,c => c.charCodeAt(0))], {type:"application/pdf"}));
      const link = document.createElement("a");
      link.href = href;
      link.download = doc.nom_fichier;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(href), 30000);
    } catch (error) { toast(error.message || "Téléchargement impossible."); }
    finally { button.disabled = false; }
  }

  function renderPlus() {
    setTitle("Plus");
    const installUrl = `${location.origin}${location.pathname}`;
    const qrUrl = "./install-qr.png";
    return `
      <div class="desktop-wrap grid">
        <div class="panel install-panel">
          <div class="panel-head"><h3>Installer sur téléphone</h3></div>
          <div class="install-content">
            <div class="install-qr-wrap">
              <img class="install-qr" src="${escapeHtml(qrUrl)}" alt="QR code pour ouvrir SCI RUVELON GESTION sur téléphone" width="240" height="240">
            </div>
            <div class="install-copy">
              <strong>Scannez ce QR code avec l'appareil photo du téléphone</strong>
              <p>Ouvrez ensuite le lien et ajoutez l'application à l'écran d'accueil.</p>
              <div class="install-steps">
                <div><b>Android</b><span>Chrome → menu ⋮ → Installer l'application</span></div>
                <div><b>iPhone</b><span>Safari → Partager → Sur l'écran d'accueil</span></div>
              </div>
              <a class="install-link" href="${escapeHtml(installUrl)}" target="_blank" rel="noopener">${escapeHtml(installUrl)}</a>
              <div class="actions">
                <button class="primary" onclick="App.installApp()">Installer</button>
                <button class="secondary" onclick="App.copyInstallLink()">Copier le lien</button>
              </div>
            </div>
          </div>
        </div>
        <div class="panel">
          <div class="panel-head"><h3>Compte</h3></div>
          <div class="notice info">${escapeHtml(state.user ? state.user.email : "")}</div>
          <div class="actions stack">
            <button class="primary" onclick="App.openPasswordChange()">Changer le mot de passe</button>
            <button class="secondary" onclick="App.signOut()">Se deconnecter</button>
          </div>
        </div>
      </div>`;
  }

  function renderTravauxScreen() {
    setTitle("Travaux");
    return `<div class="desktop-wrap">${renderTravaux()}</div>`;
  }

  function renderTravaux() {
    const all = state.data.travaux.map(t => ({ ...t, detail: travauxDetails(t) })).filter(t => !["entretien","etude"].includes(t.detail.rubrique));
    const years = [...new Set(all.map(t => String(t.detail.annee || "Non programme")))].sort();
    const statuses = [...new Set([...travauxStatuses, ...all.map(t => t.statut)])];
    const query = state.travauxSearch.toLocaleLowerCase("fr");
    const rows = all.filter(t => (!state.travauxYear || String(t.detail.annee || "Non programme") === state.travauxYear) &&
      (!state.travauxStatus || t.statut === state.travauxStatus) &&
      (!state.travauxOrigin || travauxOrigin(t) === state.travauxOrigin) &&
      (!query || [t.titre, t.description, t.entreprise, t.detail.localisation, t.detail.notes].join(" ").toLocaleLowerCase("fr").includes(query)))
      .sort((a, b) => String(a.detail.annee || 9999).localeCompare(String(b.detail.annee || 9999)) || String(a.priorite).localeCompare(String(b.priorite)));
    const closed = t => /Soldé|Payé|Paye|Abandonn|Realise|Réceptionné/.test(t.statut);
    const card = t => `<div class="row">
      <div class="row-main"><div><div class="row-title">${escapeHtml(t.titre)}</div><div class="row-sub">${escapeHtml(t.detail.localisation || localLabel("locaux", t.local_id) || "General")}</div></div><span class="chip">${escapeHtml(t.detail.annee || "Non programme")}</span></div>
      <div class="chips"><span class="chip ${/^P[12]|Critique|Urgente/.test(t.priorite) ? "red" : "orange"}">${escapeHtml(t.priorite)}</span><span class="chip ${closed(t) ? "green" : ""}">${escapeHtml(t.statut)}</span></div>
      <div class="works-amounts"><span>Estimation HT <b>${euro(t.montant_estime)}</b></span><span>Devis HT <b>${t.detail.devis_ht == null ? "—" : euro(t.detail.devis_ht)}</b></span><span>Réalisé HT <b>${euro(t.montant_reel)}</b></span></div>
      ${travauxNotesHtml(t)}
      ${adminHtml(`<div class="actions"><button onclick="App.openTravaux('${t.id}')">Modifier</button><button class="danger" onclick="App.deleteTravaux('${t.id}')">Supprimer</button></div>`)}
    </div>`;
    return `
      <div class="cards works-cards">
        <div class="card"><small>Opérations à suivre</small><strong>${rows.filter(t => !closed(t)).length}</strong></div>
        <div class="card orange"><small>Estimation HT</small><strong>${euro(sum(rows, "montant_estime"))}</strong></div>
        <div class="card"><small>Devis reçus HT</small><strong>${euro(rows.reduce((s,t) => s + Number(t.detail.devis_ht || 0), 0))}</strong></div>
        <div class="card green"><small>Réalisé HT</small><strong>${euro(sum(rows, "montant_reel"))}</strong></div>
      </div>
      <div class="panel">
        <div class="panel-head"><h3>Programmation par année</h3></div>
        <div class="table-wrap desktop-table"><table class="data-table works-summary"><thead><tr><th>Année cible</th><th>Opérations</th><th>Estimation HT</th><th>Devis HT</th><th>Réalisé HT</th></tr></thead><tbody>${years.map(y => {
          const group = all.filter(t => String(t.detail.annee || "Non programme") === y);
          return `<tr><td><button class="table-action" onclick="App.filterTravaux('travauxYear','${escapeHtml(y)}')">${escapeHtml(y)}</button></td><td>${group.length}</td><td>${euro(sum(group,"montant_estime"))}</td><td>${euro(group.reduce((s,t)=>s+Number(t.detail.devis_ht||0),0))}</td><td>${euro(sum(group,"montant_reel"))}</td></tr>`;
        }).join("")}</tbody></table></div>
        <div class="list mobile-list">${years.map(y => {
          const group = all.filter(t => String(t.detail.annee || "Non programme") === y);
          return `<div class="row"><div class="row-main"><button class="table-action" onclick="App.filterTravaux('travauxYear','${escapeHtml(y)}')">${escapeHtml(y)}</button><span>${group.length} opérations</span></div><div class="works-amounts"><span>Estimation HT<b>${euro(sum(group,"montant_estime"))}</b></span><span>Devis HT<b>${euro(group.reduce((s,t)=>s+Number(t.detail.devis_ht||0),0))}</b></span><span>Réalisé HT<b>${euro(sum(group,"montant_reel"))}</b></span></div></div>`;
        }).join("")}</div>
      </div>
      <div class="panel works-panel">
        <div class="panel-head"><h3>${rows.length} travaux du bâtiment</h3>${adminHtml(`<button class="primary" onclick="App.openTravaux()">Ajouter</button>`)}</div>
        <div class="toolbar works-filters">
          <select aria-label="Origine des travaux" onchange="App.filterTravaux('travauxOrigin',this.value)"><option value="">Toutes les origines</option>${Object.entries(travauxOrigins).map(([value,label])=>`<option value="${value}" ${state.travauxOrigin===value?"selected":""}>${label}</option>`).join("")}</select>
          <input type="search" aria-label="Rechercher des travaux" placeholder="Rechercher travaux, lieu, entreprise" value="${escapeHtml(state.travauxSearch)}" onchange="App.filterTravaux('travauxSearch',this.value)">
          <select aria-label="Année travaux" onchange="App.filterTravaux('travauxYear',this.value)"><option value="">Toutes les années</option>${years.map(y=>`<option ${state.travauxYear===y?"selected":""}>${escapeHtml(y)}</option>`).join("")}</select>
          <select aria-label="Statut travaux" onchange="App.filterTravaux('travauxStatus',this.value)"><option value="">Tous les statuts</option>${statuses.map(s=>`<option ${state.travauxStatus===s?"selected":""}>${escapeHtml(s)}</option>`).join("")}</select>
        </div>
        <div class="table-wrap desktop-table"><table class="data-table works-table"><thead><tr><th>Année</th><th>Travaux / lieu</th><th>Priorité</th><th>Avancement</th><th>Estim. HT</th><th>Devis HT</th><th>Réel HT</th><th>Actions</th></tr></thead><tbody>${rows.map(t=>`<tr><td><strong>${escapeHtml(t.detail.annee || "À définir")}</strong></td><td><strong>${escapeHtml(t.titre)}</strong><div class="table-sub">${escapeHtml(t.detail.localisation || localLabel("locaux", t.local_id))}</div>${travauxNotesHtml(t)}</td><td><span class="chip ${/^P[12]/.test(t.priorite)?"red":""}">${escapeHtml(t.priorite)}</span></td><td>${escapeHtml(t.statut)}</td><td class="num">${euro(t.montant_estime)}</td><td class="num">${t.detail.devis_ht==null?"—":euro(t.detail.devis_ht)}</td><td class="num">${euro(t.montant_reel)}</td><td>${adminHtml(`<div class="actions"><button class="table-action" onclick="App.openTravaux('${t.id}')">Modifier</button><button class="danger" onclick="App.deleteTravaux('${t.id}')">Supprimer</button></div>`)}</td></tr>`).join("")}</tbody></table>${!rows.length?'<div class="empty">Aucune opération pour ces filtres</div>':""}</div>
        <div class="list mobile-list">${rows.length?rows.map(card).join(""):'<div class="empty">Aucune opération pour ces filtres</div>'}</div>
      </div>`;
  }

  const entretienCategories = { menage: "Ménage et nettoyage", chaudiere: "Entretien chaudière", espaces_verts: "Espaces verts", relevage: "Poste de relevage", incendie: "Défense incendie", autre: "Autre entretien" };
  const entretienFrequences = ["Ponctuel", "Hebdomadaire", "Mensuel", "Trimestriel", "Semestriel", "Annuel"];
  const travauxOrigins = {nouveau:"Nouveau / imprévu",base:"Base Matthieu",acte_avant_gerance:"Déjà acté avant ma gérance"};
  const travauxStatuses = ["0 - À chiffrer", "1 - Devis demandé", "2 - Devis reçu", "3 - Validé propriétaire", "4 - OS émis", "5 - En cours", "6 - Réceptionné", "7 - Soldé / Payé", "X - Reporté", "X - Abandonné"];

  function entretienForecast(rows, currentYear) {
    const byYear = new Map();
    const unplanned = [];
    const bucket = year => {
      if (!byYear.has(year)) byYear.set(year, {year, recurring:0, oneOff:0, billed:0, billedTtc:0, unconfirmed:0});
      return byYear.get(year);
    };
    for (let year=currentYear; year<=currentYear+2; year++) bucket(year);
    const entries = rows.map(t => {
      const d = t.detail || travauxDetails(t);
      const planned = Number(String(t.date_prevue || "").slice(0,4)) || Number(d.annee) || 0;
      const actual = money(t.montant_reel);
      const billedYear = actual ? Number(String(d.date_document || t.date_realisation || "").slice(0,4)) || planned : 0;
      return {t,d,planned,actual,billedYear};
    });
    for (const {planned,billedYear} of entries) {
      if (planned) bucket(planned);
      if (billedYear) bucket(billedYear);
    }
    for (const {t,d,planned,actual,billedYear} of entries) {
      if (billedYear) {
        bucket(billedYear).billed += actual;
        bucket(billedYear).billedTtc += maintenanceTtc(actual,d.montant_document_ttc);
      }
      const recurring = entretienFrequences.includes(d.entretien_frequence) && d.entretien_frequence !== "Ponctuel";
      const pending = money(d.budget_indique);
      const estimate = money(t.montant_estime) || money(d.devis_ht);
      const cancelled = /^X\s*-|abandonn|reporté/i.test(t.statut || "");
      if (actual && !billedYear) unplanned.push({title:t.titre, amount:actual, basis:"HT facturé"});
      if (cancelled || d.entretien_exclure_budget === true || (!estimate && !pending) || (!recurring && actual)) continue;
      const years = recurring
        ? [...byYear.keys()].filter(y => y >= Math.max(currentYear,planned || Number(String(d.date_document || "").slice(0,4))))
        : planned ? [planned] : [];
      if (!years.length && !billedYear) unplanned.push({title:t.titre, amount:pending || estimate, basis:pending ? "HT/TTC à préciser" : "HT"});
      for (const year of years) {
        const total = bucket(year);
        if (pending) {
          if (year !== billedYear) total.unconfirmed += pending;
        } else {
          // Keep the annual target, without counting an already invoiced amount twice.
          total[recurring ? "recurring" : "oneOff"] += year === billedYear ? Math.max(0,estimate-actual) : estimate;
        }
      }
    }
    return {years:[...byYear.values()].sort((a,b)=>a.year-b.year).map(r=>({...r,total:round2(r.recurring+r.oneOff+r.billed)})), unplanned};
  }

  function entretienAnnualDefaults() {
    const rows = state.data.travaux.map(t=>({...t,detail:travauxDetails(t)})).filter(t=>t.detail.rubrique==="entretien");
    const current = Number(currentMonth().slice(0,4));
    const byYear = new Map();
    const put = (year,key,field,value) => {
      if (!byYear.has(year)) byYear.set(year,{posts:{}});
      const posts = byYear.get(year).posts;
      if (!posts[key]) posts[key] = {prevision:null,reel:null};
      posts[key][field] = round2(value) || null;
    };
    for (const key of Object.keys(entretienCategories)) {
      const group = rows.filter(t=>(t.detail.entretien_categorie || "autre")===key);
      for (const row of entretienForecast(group,current).years) {
        put(row.year,key,"reel",row.billed);
        put(row.year,key,"reel_ttc",row.billedTtc);
      }
      // Project the original budget independently from invoices and actual spending.
      for (const row of entretienForecast(group.map(t=>({...t,montant_reel:0})),current).years) put(row.year,key,"prevision",row.recurring+row.oneOff);
    }
    return byYear;
  }

  function renderEntretienUnassigned(rows) {
    const {unplanned} = entretienForecast(rows,Number(currentMonth().slice(0,4)));
    const pending = rows.filter(t=>money(t.detail.budget_indique) && !t.detail.entretien_exclure_budget);
    const notes = [
      ...pending.map(t=>({title:t.titre,amount:money(t.detail.budget_indique),basis:"HT/TTC à préciser"})),
      ...unplanned.filter(r=>r.basis!=="HT/TTC à préciser")
    ];
    return notes.length ? `<div class="notice info"><strong>Montants des fiches à préciser · hors total HT</strong><ul>${notes.map(r=>`<li>${escapeHtml(r.title)} : ${euro(r.amount)} (${r.basis})</li>`).join("")}</ul></div>` : "";
  }

  function renderEntretien() {
    setTitle("Entretien");
    const all = state.data.travaux.map(t => ({...t, detail: travauxDetails(t)})).filter(t => t.detail.rubrique === "entretien");
    const rows = all.filter(t => !state.entretienCategorie || t.detail.entretien_categorie === state.entretienCategorie)
      .sort((a,b) => String(a.date_prevue || "9999").localeCompare(String(b.date_prevue || "9999")) || a.titre.localeCompare(b.titre,"fr"));
    const label = t => entretienCategories[t.detail.entretien_categorie] || "À classer";
    const date = t => fmtDate(t.date_prevue) || (t.detail.annee ? `${t.detail.annee} · date à définir` : "À définir");
    const amount = t => Number(t.montant_reel) || (t.detail.devis_ht ?? t.montant_estime);
    const ttcAmount = t => maintenanceTtc(amount(t),t.montant_reel || t.detail.devis_ht!=null ? t.detail.montant_document_ttc : undefined);
    const place = t => t.detail.localisation || localLabel("locaux", t.local_id);
    const actions = t => adminHtml(`<div class="actions"><button class="table-action" onclick="App.openTravaux('${t.id}')">Modifier</button><button class="danger" onclick="App.deleteTravaux('${t.id}')">Supprimer</button></div>`);
    return `<div class="desktop-wrap">${renderAnnualLedger("entretien")}${renderEntretienUnassigned(all)}<section class="panel works-panel entretien-details">
      <div class="panel-head"><h3>Suivi de l’entretien</h3>${adminHtml('<button class="primary" onclick="App.openTravaux()">Ajouter</button>')}</div>
      <div class="toolbar"><select aria-label="Catégorie d’entretien" onchange="App.filterTravaux('entretienCategorie',this.value)"><option value="">Toutes les catégories</option>${Object.entries(entretienCategories).map(([key,value]) => `<option value="${key}" ${state.entretienCategorie===key?"selected":""}>${value}</option>`).join("")}</select></div>
      ${rows.length ? `<div class="table-wrap desktop-table"><table class="data-table"><thead><tr><th>Prestation</th><th>Catégorie / fréquence</th><th>Prestataire</th><th>Date prévue</th><th>Avancement</th><th>Montant HT</th><th>Montant TTC</th><th>Actions</th></tr></thead><tbody>
      ${rows.map(t => `<tr><td><strong>${escapeHtml(t.titre)}</strong><div class="table-sub">${escapeHtml(place(t))}</div>${travauxNotesHtml(t)}</td><td>${escapeHtml(label(t))}<div class="table-sub">${escapeHtml(t.detail.entretien_frequence || "À définir")}</div></td><td>${escapeHtml(t.entreprise || "—")}</td><td>${escapeHtml(date(t))}</td><td>${escapeHtml(t.statut)}</td><td class="num">${euro(amount(t))}</td><td class="num">${euro(ttcAmount(t))}</td><td>${actions(t)}</td></tr>`).join("")}
      </tbody></table></div><div class="list mobile-list">${rows.map(t => `<div class="row"><div class="row-title">${escapeHtml(t.titre)}</div><div class="row-sub">${escapeHtml(place(t))}</div><div class="chips"><span class="chip">${escapeHtml(label(t))}</span><span class="chip">${escapeHtml(t.detail.entretien_frequence || "Fréquence à définir")}</span></div><div class="row-sub">Date prévue : ${escapeHtml(date(t))}</div><div>${escapeHtml(t.statut)} · ${euro(amount(t))} HT · ${euro(ttcAmount(t))} TTC</div>${travauxNotesHtml(t)}${actions(t)}</div>`).join("")}</div>` : '<div class="empty">Aucune prestation dans cette catégorie</div>'}
    </section></div>`;
  }

  function travauxDetails(row) {
    try {
      const d = JSON.parse(row.observations || "{}");
      if (d.version_travaux) return d;
    } catch (error) {}
    return { annee: row.date_prevue ? Number(row.date_prevue.slice(0,4)) : null, localisation: "", notes: row.observations || "", devis_ht: null };
  }

  const etudeStatuses = ["À étudier","En cours","Terminée","Reportée","Abandonnée"];

  function etudePeriod(detail) {
    const start = fmtDate(detail.etude_debut);
    const end = fmtDate(detail.etude_fin);
    if (start && end) return `Du ${start} au ${end}`;
    if (start) return `À partir du ${start}`;
    return end ? `Échéance : ${end}` : detail.etude_periode || "À définir";
  }

  function renderEtudes() {
    setTitle("Études");
    const query = state.etudeRecherche.toLocaleLowerCase("fr");
    const rows = state.data.travaux.map(t=>({...t,detail:travauxDetails(t)}))
      .filter(t=>t.detail.rubrique==="etude" && !t.detail.etude_travaux_id && [t.titre,t.description,t.detail.localisation,t.detail.etude_observations].join(" ").toLocaleLowerCase("fr").includes(query))
      .sort((a,b)=>String(a.detail.etude_fin || "9999").localeCompare(String(b.detail.etude_fin || "9999")) || a.titre.localeCompare(b.titre,"fr"));
    const amount = value => value == null ? "Non renseigné" : euro(value)+" HT";
    return `<section class="desktop-wrap panel works-panel etudes-panel">
      <div class="panel-head"><h3>Études à mener</h3>${adminHtml('<button class="primary" onclick="App.openEtude()">Ajouter une étude</button>')}</div>
      <div class="toolbar"><input type="search" aria-label="Rechercher une étude" placeholder="Rechercher une étude" value="${escapeHtml(state.etudeRecherche)}" onchange="App.filterEtudes(this.value)"></div>
      <div class="list">${rows.length ? rows.map(t=>{
        const d=t.detail;
        return `<article class="row"><div class="row-main"><div><div class="row-title">${escapeHtml(t.titre)}</div><div class="row-sub">${escapeHtml([d.localisation || localLabel("locaux",t.local_id),t.entreprise].filter(Boolean).join(" · "))}</div></div><span class="chip">${escapeHtml(t.statut)}</span></div>
          <div><strong>Problématique</strong><div class="row-sub">${escapeHtml(t.description || "À préciser")}</div></div>
          <div class="works-amounts"><span>Période<b>${escapeHtml(etudePeriod(d))}</b></span><span>Coût estimé<b>${d.etude_cout_estime_ht==null && d.etude_cout_indique ? euro(d.etude_cout_indique)+" (HT/TTC à préciser)" : amount(d.etude_cout_estime_ht)}</b></span><span>Coût réel<b>${amount(d.etude_cout_reel_ht)}</b></span></div>
          <details class="works-details"><summary>Observations détaillées</summary><p>${escapeHtml(d.etude_observations || d.notes || "Aucune observation")}</p>${d.note_matt?`<p><b>Annotation Matthieu :</b> ${escapeHtml(d.note_matt)}</p>`:""}</details>
          ${adminHtml(`<div class="actions"><button onclick="App.openEtude('${t.id}')">Modifier</button></div>`)}
        </article>`;
      }).join("") : '<div class="empty">Aucune étude</div>'}</div>
    </section>`;
  }

  function travauxOrigin(row) {
    const d = row.detail || travauxDetails(row);
    return Object.hasOwn(travauxOrigins,d.origine) ? d.origine : (String(d.source_key || "").startsWith("ruvelon_travaux_v2_") ? "base" : "nouveau");
  }

  function travauxNotesHtml(t) {
    const d = t.detail || travauxDetails(t);
    const ppi = Object.entries(d.ppi || {}).filter(([,value])=>Number(value)).map(([year,value])=>`${year} : ${euro(value)} HT`).join(" / ");
    const origin = travauxOrigin(t);
    const originBadge = `<div class="chips"><span class="chip ${origin==="nouveau"?"orange":""}">${travauxOrigins[origin]}</span>${!d.annee && !t.date_prevue?'<span class="chip">Date à définir</span>':""}</div>`;
    return originBadge + `<details class="works-details"><summary>Détail / décisions</summary><p>${escapeHtml(t.description || "")}</p>${d.note_matt?`<p><b>Annotation Matthieu :</b> ${escapeHtml(d.note_matt)}</p>`:""}${d.notes?`<p>${escapeHtml(d.notes)}</p>`:""}${d.imputation?`<p><b>Imputation :</b> ${escapeHtml(d.imputation)}</p>`:""}${ppi?`<p><b>PPI du fichier :</b> ${escapeHtml(ppi)}</p>`:""}<p>${escapeHtml(t.entreprise || "")}${t.date_realisation?` · Réception : ${fmtDate(t.date_realisation)}`:""}</p></details>`;
  }

  function renderRemunerationScreen() {
    setTitle("Rémunération");
    return `<div class="desktop-wrap">${renderRemuneration()}</div>`;
  }

  function monthLabel(value) {
    if (!value) return "";
    const date = new Date(`${String(value).slice(0, 7)}-15T12:00:00`);
    return date.toLocaleDateString("fr-FR", { month: "long", year: "numeric" });
  }

  function parseRemunerationDetails(row) {
    const fallback = {
      version: 1,
      encaissements: [],
      interventions: [],
      primes: [],
      notes: ""
    };
    const raw = String(row && row.observations || "").trim();
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        if (parsed && Number(parsed.version) >= 1) {
          return {
            version: 1,
            encaissements_source: parsed.encaissements_source || "manuel",
            encaissements_manuel_volontaire: parsed.encaissements_manuel_volontaire === true,
            encaissements: Array.isArray(parsed.encaissements) ? parsed.encaissements : [],
            interventions: Array.isArray(parsed.interventions) ? parsed.interventions : [],
            primes: Array.isArray(parsed.primes) ? parsed.primes : [],
            notes: String(parsed.notes || "")
          };
        }
      } catch (error) {
        fallback.notes = raw;
      }
    }
    if (Number(row && row.encaissements_ht) > 0) {
      fallback.encaissements.push({
        local: "",
        locataire: "Total mensuel",
        loyer_ht: Number(row.encaissements_ht) || 0,
        encaissement_ht: Number(row.encaissements_ht) || 0,
        observations: ""
      });
    }
    return fallback;
  }

  function remunerationMonthValues(row) {
    return {
      brut: Number(row.remuneration_brute_7pc) || round2((Number(row.encaissements_ht) || 0) * 0.07),
      net: Number(row.remuneration_apres_abattement) || round2((Number(row.encaissements_ht) || 0) * 0.07 * 0.70),
      primes: round2((Number(row.prime_edl) || 0) + (Number(row.prime_responsabilite) || 0)),
      fraisKm: Number(row.frais_km) || round2((Number(row.km) || 0) * (Number(row.bareme_km) || 0.636)),
      total: Number(row.total_compte_courant) || 0
    };
  }

  function pointedReceipts(month, previous = {}) {
    const rows = state.data.loyers_mensuels.filter(r => String(r.mois).slice(0, 7) === String(month).slice(0, 7));
    if (!rows.length) {
      const sameMonth = String(previous.mois).slice(0, 7) === String(month).slice(0, 7);
      const savedHabitual = sameMonth ? sum(parseRemunerationDetails(previous).encaissements, "loyer_ht") || Number(previous.encaissements_ht) || 0 : 0;
      const leases = state.data.baux.filter(b => b.statut === "Actif" && !isSecondaryBail(b) && b.date_debut <= monthEndDate(month) && (!b.date_fin || b.date_fin >= monthDate(month)));
      const habitual = money(savedHabitual || sum(leases, "loyer_ht"));
      return [{ locataire: "Total du mois", loyer_ht: habitual, encaissement_ht: habitual, observations: "Sans pointage : encaissement supposé égal au loyer HT habituel." }];
    }
    const paidHt = round2(rows.reduce((total, r) => {
      const expected = Math.max(0, Number(r.total_attendu) || 0);
      const paid = Math.min(expected, Math.max(0, Number(r.total_paye) || 0));
      const ht = Math.max(0, Number(r.loyer_ht) || 0);
      return total + (expected > 0 ? round2(ht * paid / expected) : 0);
    }, 0));
    return [{ locataire: "Total du mois", loyer_ht: sum(rows, "loyer_ht"), encaissement_ht: paidHt, observations: "Totaux du pointage mensuel, hors TVA et charges." }];
  }

  function remunerationReceiptSource(row) {
    const details = parseRemunerationDetails(row);
    if (details.encaissements_source === "manuel" && details.encaissements_manuel_volontaire) return "manuel";
    return "pointage";
  }

  async function syncPointedRemuneration() {
    if (!state.isAdmin) return;
    let changed = false;
    for (const row of state.data.remuneration_gerant) {
      const details = parseRemunerationDetails(row);
      if (details.encaissements_source !== "pointage") continue;
      const receipts = pointedReceipts(row.mois, row);
      const ht = sum(receipts, "encaissement_ht");
      if (ht === Number(row.encaissements_ht) && JSON.stringify(receipts) === JSON.stringify(details.encaissements)) continue;
      details.encaissements = receipts;
      await dbSave("remuneration_gerant", { ...row, encaissements_ht: ht, observations: JSON.stringify(details) });
      changed = true;
    }
    if (changed) state.data.remuneration_gerant = await dbList("remuneration_gerant");
  }

  function isVisit(line) {
    return line.motif_deplacement === "visite" || /visit/i.test(String(line.activite || ""));
  }

  function travelTotals(interventions, rate) {
    const kmTotal = round2(interventions.reduce((s, l) => s + numberValue(l.km), 0));
    const km = round2(interventions.filter(l => !isVisit(l) && !l.non_facturable).reduce((s, l) => s + numberValue(l.km), 0));
    const kmPerso = round2(kmTotal - km);
    return { km, kmTotal, kmPerso, fraisKm: round2(km * rate), fraisPerso: round2(kmPerso * PERSONAL_VEHICLE_COST_PER_KM), coutDeplacements: round2(kmTotal * PERSONAL_VEHICLE_COST_PER_KM) };
  }

  function savedTravel(row) {
    const saved = parseRemunerationDetails(row).interventions.map(l => ({ ...l, activite: "", motif_deplacement: "", non_facturable: l.non_facturable === true || l.motif_deplacement === "visite" }));
    return travelTotals(saved, Number(row.bareme_km) || 0.636);
  }

  function renderRemuneration() {
    const rows = state.data.remuneration_gerant.filter((r) => String(r.annee) === String(state.year)).sort((a, b) => String(a.mois).localeCompare(String(b.mois)));
    const total = sum(rows, "total_compte_courant");
    const ht = sum(rows, "encaissements_ht");
    const net = sum(rows, "remuneration_apres_abattement");
    const primes = round2(sum(rows, "prime_edl") + sum(rows, "prime_responsabilite"));
    const fraisKm = sum(rows, "frais_km");
    const heures = sum(rows, "heures");
    const autres = sum(rows, "autres_frais");
    const perso = round2(rows.reduce((s, r) => s + savedTravel(r).fraisPerso, 0));
    const kmPerso = round2(rows.reduce((s, r) => s + savedTravel(r).kmPerso, 0));
    return `
      <div class="panel">
        <div class="panel-head"><h3>Suivi remuneration gerant</h3>${adminHtml(`<button class="primary" onclick="App.openRemuneration()">Saisir un mois</button>`)}</div>
        <div class="toolbar"><input type="number" value="${state.year}" onchange="App.setYear(this.value)">${adminHtml(`<button class="secondary" onclick="App.prepareRemunerationYear()">Creer mois</button>`)}</div>
        <div class="cards remuneration-cards">
          <div class="card"><small>HT encaisse</small><strong>${euro(ht)}</strong></div>
          <div class="card"><small>Remuneration nette</small><strong>${euro(net)}</strong></div>
          <div class="card"><small>Primes</small><strong>${euro(primes)}</strong></div>
          <div class="card"><small>Frais km</small><strong>${euro(fraisKm)}</strong></div>
          <div class="card orange"><small>Déplacements à ma charge · 0,47 €/km</small><strong>${euro(perso)}</strong><span>${kmPerso.toFixed(1)} km à ma charge</span></div>
          <div class="card"><small>Heures</small><strong>${heures.toFixed(2)}</strong></div>
          <div class="card green"><small>Compte courant</small><strong>${euro(total)}</strong></div>
        </div>
        ${String(state.year) === "2026" && autres ? `<div class="notice info">Autres frais 2026 : ${euro(autres)} indiques pour memoire et exclus du compte courant.</div>` : ""}
        <div class="table-wrap desktop-table remuneration-table">
          <table class="data-table">
            <thead><tr><th>Mois</th><th class="num">HT encaisse</th><th class="num">Brute 7%</th><th class="num">Nette 70%</th><th class="num">Primes</th><th class="num">Frais km</th><th class="num">Autres frais</th><th class="num">Total mois</th><th class="num">Heures</th><th></th></tr></thead>
            <tbody>${rows.map((r) => {
              const values = remunerationMonthValues(r);
              return `<tr>
                <td><strong>${escapeHtml(monthLabel(r.mois))}</strong></td>
                <td class="num">${euro(r.encaissements_ht)}</td>
                <td class="num">${euro(values.brut)}</td>
                <td class="num">${euro(values.net)}</td>
                <td class="num">${euro(values.primes)}</td>
                <td class="num">${euro(values.fraisKm)}<div class="table-sub">À ma charge : ${savedTravel(r).kmPerso.toFixed(1)} km · ${euro(savedTravel(r).fraisPerso)}</div></td>
                <td class="num">${euro(r.autres_frais)}<div class="table-sub">${r.autres_frais_inclus_total ? "inclus" : "hors total"}</div></td>
                <td class="num"><strong>${euro(values.total)}</strong></td>
                <td class="num">${Number(r.heures || 0).toFixed(2)}</td>
                <td>${adminHtml(`<button class="table-action" onclick="App.openRemuneration('${r.id}')">Detail</button>`)}</td>
              </tr>`;
            }).join("")}</tbody>
            ${rows.length ? `<tfoot><tr><th>Total ${escapeHtml(state.year)}</th><th class="num">${euro(ht)}</th><th></th><th class="num">${euro(net)}</th><th class="num">${euro(primes)}</th><th class="num">${euro(fraisKm)}</th><th class="num">${euro(autres)}</th><th class="num">${euro(total)}</th><th class="num">${heures.toFixed(2)}</th><th></th></tr></tfoot>` : ""}
          </table>
        </div>
        <div class="list mobile-list">${rows.length ? rows.map((r) => {
          const values = remunerationMonthValues(r);
          return `<div class="row">
            <div class="row-main"><div><div class="row-title">${escapeHtml(monthLabel(r.mois))}</div><div class="row-sub">HT ${euro(r.encaissements_ht)} - ${Number(r.heures || 0).toFixed(2)} h</div></div><div class="row-amount">${euro(values.total)}</div></div>
            <div class="chips"><span class="chip">Nette ${euro(values.net)}</span><span class="chip">Primes ${euro(values.primes)}</span><span class="chip">Km ${Number(r.km) || 0}</span><span class="chip ${r.autres_frais_inclus_total ? "orange" : ""}">Autres ${euro(r.autres_frais)}</span></div>
            <div class="row-sub">À ma charge : ${savedTravel(r).kmPerso.toFixed(1)} km · ${euro(savedTravel(r).fraisPerso)} (0,47 €/km)</div>
            ${adminHtml(`<div class="actions"><button onclick="App.openRemuneration('${r.id}')">Ouvrir le detail</button></div>`)}
          </div>`;
        }).join("") : `<div class="empty">Aucune ligne pour ${state.year}</div>`}</div>
      </div>`;
  }

  function sum(rows, field) {
    return round2(rows.reduce((total, r) => total + (Number(r[field]) || 0), 0));
  }

  function daysUntil(date) {
    if (!date) return 9999;
    const due = new Date(`${String(date).slice(0, 10)}T12:00:00`);
    const now = new Date();
    now.setHours(12, 0, 0, 0);
    return Math.ceil((due - now) / 86400000);
  }

  async function generateRents() {
    if (!ensureAdminAction()) return;
    const rows = getMonthRows();
    if (rows.length && !confirm(`Il existe deja ${rows.length} ligne(s) pour ${state.month}. Ajouter seulement les baux manquants ?`)) return;
    const existingByBail = new Set(rows.map((r) => r.bail_id).filter(Boolean));
    const baux = activeBaux().filter((b) => !existingByBail.has(b.id));
    for (const b of baux) {
      const base = loyerFromBail(b.id);
      if (!base) continue;
      await dbSave("loyers_mensuels", {
        mois: monthDate(state.month),
        ...base,
        total_paye: 0,
        facture_meg_faite: false,
        paiement_controle: false
      });
    }
    await refresh(`Lignes creees : ${baux.length}`);
  }

  function loyerFromBail(bailId) {
    const b = state.data.baux.find((x) => x.id === bailId);
    if (!b) return null;
    const loyerHt = money(b.loyer_ht);
    const tva = money(loyerHt * (Number(b.tva) || 0) / 100);
    const loyerTtc = money(loyerHt + tva);
    const charges = money(b.charges_mensuelles);
    return {
      bail_id: b.id,
      local_id: b.local_id || "",
      locataire_id: b.locataire_id || "",
      loyer_ht: loyerHt,
      tva,
      loyer_ttc: loyerTtc,
      charges_mensuelles: charges,
      total_attendu: money(loyerTtc + charges)
    };
  }

  function bailOptions(emptyLabel) {
    return [{ value: "", label: emptyLabel || "Choisir" }].concat(activeBaux().map((b) => {
      const d = loyerFromBail(b.id);
      return {
        value: b.id,
        label: `${localLabel("locataires", b.locataire_id)} - ${localLabel("locaux", b.local_id)} - ${euro(d ? d.total_attendu : 0)}`
      };
    }));
  }

  async function refresh(message) {
    await loadAll();
    await syncPointedRemuneration();
    render();
    if (message) toast(message);
  }

  function openModal(title, html) {
    $("#modal-title").textContent = title;
    $("#modal-body").innerHTML = html;
    const form = $("#modal-body").querySelector("form[data-action]");
    if (form) {
      form.addEventListener("submit", async (e) => {
        e.preventDefault();
        const action = form.dataset.action || "save";
        if (action === "saveRemuneration") await window.App.saveRemuneration(form);
        else if (action === "savePassword") await window.App.savePassword(form);
        else if (action === "saveReport") await window.App.saveReport(form);
        else if (action === "saveAnnual") await window.App.saveAnnual(form);
        else if (action === "saveEtude") await window.App.saveEtude(form);
        else await window.App.save(form.dataset.table, form);
      });
    }
    $("#modal").hidden = false;
  }

  function closeModal() {
    $("#modal").hidden = true;
    $("#modal-body").innerHTML = "";
  }

  function toast(msg) {
    const el = $("#toast");
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => { el.hidden = true; }, 2800);
  }

  function formHtml(fields, table, actionName) {
    return `
      <form id="edit-form" class="form-grid" data-table="${escapeHtml(table || "")}" data-action="${escapeHtml(actionName || "save")}">
        ${fields.map(fieldHtml).join("")}
        <div class="form-actions">
          <button class="secondary" type="button" onclick="App.closeModal()">Annuler</button>
          <button class="primary" type="submit">Enregistrer</button>
        </div>
      </form>
    `;
  }

  function fieldHtml(f) {
    const attrs = fieldAttrs(f);
    if (f.type === "hidden") return `<input type="hidden" name="${f.name}" value="${escapeHtml(f.value)}" ${attrs}>`;
    if (f.type === "select") {
      return `<label>${escapeHtml(f.label)}<select name="${f.name}" ${attrs}>${f.options.map((o) => `<option value="${escapeHtml(o.value)}" ${String(o.value) === String(f.value || "") ? "selected" : ""}>${escapeHtml(o.label)}</option>`).join("")}</select></label>`;
    }
    if (f.type === "textarea") return `<label class="field-full">${escapeHtml(f.label)}<textarea name="${f.name}" ${attrs}>${escapeHtml(f.value || "")}</textarea></label>`;
    if (f.type === "checkbox") return `<label class="notice info"><input type="checkbox" name="${f.name}" value="true" ${f.value ? "checked" : ""} ${attrs}> ${escapeHtml(f.label)}</label>`;
    return `<label>${escapeHtml(f.label)}<input type="${f.type || "text"}" name="${f.name}" value="${escapeHtml(f.value ?? "")}" ${attrs}></label>`;
  }

  function fieldAttrs(f) {
    return [
      f.step ? `step="${escapeHtml(f.step)}"` : "",
      f.min !== undefined ? `min="${escapeHtml(f.min)}"` : "",
      f.readonly ? "readonly" : "",
      f.required ? "required" : "",
      f.onchange ? `onchange="${escapeHtml(f.onchange)}"` : "",
      f.oninput ? `oninput="${escapeHtml(f.oninput)}"` : ""
    ].filter(Boolean).join(" ");
  }

  function remunerationLineHtml(kind, row) {
    const r = row || {};
    const removeButton = `<button class="detail-remove" type="button" title="Retirer cette ligne" aria-label="Retirer cette ligne" onclick="App.removeRemunerationLine(this)">×</button>`;
    if (kind === "encaissements") {
      return `<div class="detail-line encaissement-line" data-detail-kind="encaissements">
        ${removeButton}
        <label>Local<input data-field="local" value="${escapeHtml(r.local || "")}"></label>
        <label>Locataire<input data-field="locataire" value="${escapeHtml(r.locataire || "")}"></label>
        <label>Loyer HT habituel<input type="number" step="0.01" min="0" data-field="loyer_ht" value="${escapeHtml(r.loyer_ht || 0)}" oninput="App.recalcRemunerationForm(this.form)"></label>
        <label>Encaissement reel HT<input type="number" step="0.01" min="0" data-field="encaissement_ht" value="${escapeHtml(r.encaissement_ht || 0)}" oninput="App.recalcRemunerationForm(this.form)"></label>
        <label class="detail-note">Observation<input data-field="observations" value="${escapeHtml(r.observations || "")}"></label>
      </div>`;
    }
    if (kind === "interventions") {
      const activities = [...new Set(["Comptabilité", "Gestion locataire", "Gestion entreprise travaux", "Facturation loyers", "Rédaction baux", "Rédaction reçu", "Gestion divers", "Intervention travaux", "Visite de local", r.activite].filter(Boolean))];
      return `<div class="detail-line intervention-line" data-detail-kind="interventions">
        <div class="intervention-fields intervention-inline">
        <label>Date<input type="date" data-field="date" value="${escapeHtml(String(r.date || "").slice(0, 10))}"></label>
        <label>Temps passé (heures)<input type="number" step="0.25" min="0" data-field="heures" value="${escapeHtml(r.heures || 0)}" oninput="App.recalcRemunerationForm(this.form)"></label>
        <label>Activité<select data-field="activite" onchange="App.recalcRemunerationForm(this.form)"><option value="">Choisir</option>${activities.map(a=>`<option value="${escapeHtml(a)}" ${a===r.activite?"selected":""}>${escapeHtml(a)}</option>`).join("")}</select></label>
        <label>Local<input data-field="local" value="${escapeHtml(r.local || "")}"></label>
        <label>Motif<select data-field="motif_deplacement" onchange="App.recalcRemunerationForm(this.form)"><option value="autre" ${r.motif_deplacement!=="visite"?"selected":""}>Autre intervention</option><option value="visite" ${r.motif_deplacement==="visite"?"selected":""}>Visite de local</option></select></label>
        <label>Km aller-retour<input type="number" step="0.1" min="0" data-field="km" value="${escapeHtml(r.km || 0)}" oninput="App.recalcRemunerationForm(this.form)"></label>
        <label class="intervention-billing">Non facturable SCI<span class="intervention-check"><input type="checkbox" data-field="non_facturable" ${r.non_facturable?"checked":""} onchange="App.recalcRemunerationForm(this.form)"></span></label>${removeButton}
        </div>
        <details class="intervention-extra" ${r.autres_frais || r.observations?"open":""}><summary>Frais et observation · SCI <strong data-travel="sci"></strong> · À ma charge <strong data-travel="perso"></strong></summary>
        <div class="intervention-fields intervention-notes"><label>Autres frais (€)<input type="number" step="0.01" min="0" data-field="autres_frais" value="${escapeHtml(r.autres_frais || 0)}" oninput="App.recalcRemunerationForm(this.form)"></label><label>Observation<input data-field="observations" value="${escapeHtml(r.observations || "")}"></label></div></details>
      </div>`;
    }
    const situations = [
      ["Sans interruption", "Sans interruption - 100%"],
      ["Interruption moins 1 mois", "Interruption < 1 mois - 50%"],
      ["Interruption plus 1 mois", "Interruption > 1 mois - 25%"],
      ["Montant manuel", "Montant manuel"]
    ];
    const selected = r.situation || "Sans interruption";
    return `<div class="detail-line prime-line" data-detail-kind="primes">
      ${removeButton}
      <label>Date<input type="date" data-field="date" value="${escapeHtml(String(r.date || "").slice(0, 10))}"></label>
      <label>Local<input data-field="local" value="${escapeHtml(r.local || "")}"></label>
      <label>Type<input data-field="type" value="${escapeHtml(r.type || "Entree")}"></label>
      <label>Loyer HT de reference<input type="number" step="0.01" min="0" data-field="loyer_reference" value="${escapeHtml(r.loyer_reference || 0)}" oninput="App.recalcRemunerationForm(this.form)"></label>
      <label>Situation<select data-field="situation" onchange="App.recalcRemunerationForm(this.form)">${situations.map((option) => `<option value="${option[0]}" ${option[0] === selected ? "selected" : ""}>${option[1]}</option>`).join("")}</select></label>
      <label>Prime<input type="number" step="0.01" min="0" data-field="prime" value="${escapeHtml(r.prime || 0)}" oninput="App.recalcRemunerationForm(this.form)"></label>
      <label class="detail-note">Observation<input data-field="observations" value="${escapeHtml(r.observations || "")}"></label>
    </div>`;
  }

  function remunerationFormHtml(row) {
    const r = row || {};
    const details = parseRemunerationDetails(r);
    const encaissements = details.encaissements.length ? details.encaissements : [{}];
    const interventions = details.interventions.length ? details.interventions : [{}];
    const primes = details.primes.length ? details.primes : [{}];
    const receiptSource = remunerationReceiptSource(r);
    return `<form id="edit-form" class="remuneration-form" data-table="remuneration_gerant" data-action="saveRemuneration">
      <input type="hidden" name="id" value="${escapeHtml(r.id || "")}">
      <input type="hidden" name="bareme_km" value="${escapeHtml(r.bareme_km || 0.636)}">
      <div class="detail-month-head">
        <label>Mois<input type="month" name="mois" value="${escapeHtml(String(r.mois || monthDate(state.month)).slice(0, 7))}" required onchange="App.recalcRemunerationForm(this.form)"></label>
        <label>Encaissements HT<select name="encaissements_source" onchange="App.recalcRemunerationForm(this.form)"><option value="pointage" ${receiptSource==="pointage"?"selected":""}>Automatique depuis le pointage MEG</option><option value="manuel" ${receiptSource==="manuel"?"selected":""}>Saisie manuelle (dérogation)</option></select></label>
        <label>Prime responsabilite<input type="number" step="0.01" min="0" name="prime_responsabilite" value="${escapeHtml(r.prime_responsabilite || 0)}" oninput="App.recalcRemunerationForm(this.form)"></label>
      </div>

      <section class="detail-section">
        <div class="detail-section-head"><div><span>1</span><h4>Encaissements HT du mois</h4></div><button type="button" class="secondary" onclick="App.addRemunerationLine('encaissements', this.form)">Ajouter</button></div>
        <div class="detail-list" data-detail-list="encaissements">${encaissements.map((line) => remunerationLineHtml("encaissements", line)).join("")}</div>
      </section>

      <section class="detail-section">
        <div class="detail-section-head"><div><span>2</span><h4>Interventions et temps passe</h4></div><button type="button" class="secondary" onclick="App.addRemunerationLine('interventions', this.form)">Ajouter</button></div>
        <div class="detail-list" data-detail-list="interventions">${interventions.map((line) => remunerationLineHtml("interventions", line)).join("")}</div>
      </section>

      <section class="detail-section">
        <div class="detail-section-head"><div><span>3</span><h4>Etats des lieux et primes</h4></div><button type="button" class="secondary" onclick="App.addRemunerationLine('primes', this.form)">Ajouter</button></div>
        <div class="detail-list" data-detail-list="primes">${primes.map((line) => remunerationLineHtml("primes", line)).join("")}</div>
      </section>

      <section class="detail-section recap-section">
        <div class="detail-section-head"><div><span>4</span><h4>Recapitulatif automatique</h4></div></div>
        <div class="recap-grid">
          <div><small>Encaissements HT</small><strong data-recap="encaissements">0.00 EUR</strong></div>
          <div><small>Total loyers HT du mois</small><strong data-recap="factures_ht">0.00 EUR</strong></div>
          <div><small>Brute 7%</small><strong data-recap="brute">0.00 EUR</strong></div>
          <div><small>Nette apres abattement</small><strong data-recap="nette">0.00 EUR</strong></div>
          <div><small>Heures</small><strong data-recap="heures">0.00</strong></div>
          <div><small>Frais km</small><strong data-recap="frais_km">0.00 EUR</strong></div>
          <div><small>Km aller-retour totaux</small><strong data-recap="km_total">0</strong></div>
          <div><small>Km facturables SCI</small><strong data-recap="km_sci">0</strong></div>
          <div><small>Km à ma charge</small><strong data-recap="km_perso">0</strong></div>
          <div><small>À ma charge · 0,47 €/km</small><strong data-recap="frais_perso">0.00 EUR</strong></div>
          <div><small>Coût véhicule total estimé · 0,47 €/km</small><strong data-recap="cout_deplacements">0.00 EUR</strong></div>
          <div><small>Primes</small><strong data-recap="primes">0.00 EUR</strong></div>
          <div><small>Autres frais</small><strong data-recap="autres">0.00 EUR</strong></div>
          <div class="recap-total"><small>Compte courant du mois</small><strong data-recap="total">0.00 EUR</strong></div>
        </div>
        <label class="notice info"><input type="checkbox" name="autres_frais_inclus_total" value="true" ${r.autres_frais_inclus_total ? "checked" : ""} onchange="App.recalcRemunerationForm(this.form)"> Integrer les autres frais au total</label>
      </section>

      <section class="detail-section">
        <div class="detail-section-head"><div><span>5</span><h4>Observations du mois</h4></div></div>
        <textarea name="detail_notes" rows="4">${escapeHtml(details.notes)}</textarea>
      </section>

      <div class="form-actions sticky-actions">
        <button class="secondary" type="button" onclick="App.closeModal()">Annuler</button>
        <button class="primary" type="submit">Enregistrer le mois</button>
      </div>
    </form>`;
  }

  function collectDetailLines(form, kind) {
    return [...form.querySelectorAll(`[data-detail-kind="${kind}"]`)].map((line) => {
      const result = {};
      line.querySelectorAll("[data-field]").forEach((field) => {
        result[field.dataset.field] = field.type === "checkbox" ? field.checked : field.type === "number" ? numberValue(field.value) : String(field.value || "").trim();
      });
      return result;
    }).filter((row) => Object.entries(row).some(([key, value]) => !["non_facturable", "motif_deplacement"].includes(key) && (typeof value === "number" ? value !== 0 : value !== "")));
  }

  function numberValue(value) {
    return round2(Number(value) || 0);
  }

  function remunerationDetailTotals(form, updatePrimeInputs) {
    const encaissements = collectDetailLines(form, "encaissements");
    const interventions = collectDetailLines(form, "interventions");
    const primeElements = [...form.querySelectorAll('[data-detail-kind="primes"]')];
    const primes = primeElements.map((line) => {
      const reference = numberValue(line.querySelector('[data-field="loyer_reference"]').value);
      const situation = line.querySelector('[data-field="situation"]').value;
      const primeInput = line.querySelector('[data-field="prime"]');
      const calculated = situation === "Montant manuel" ? numberValue(primeInput.value) : round2(reference * primeRate(situation));
      if (updatePrimeInputs && situation !== "Montant manuel") primeInput.value = calculated.toFixed(2);
      const result = {};
      line.querySelectorAll("[data-field]").forEach((field) => {
        result[field.dataset.field] = field.type === "number" ? numberValue(field.value) : String(field.value || "").trim();
      });
      result.prime = calculated;
      return result;
    }).filter((row) => row.date || row.local || row.loyer_reference || row.prime || row.observations || (row.type && row.type !== "Entree"));
    const encaissementsHt = round2(encaissements.reduce((total, line) => total + numberValue(line.encaissement_ht), 0));
    const heures = round2(interventions.reduce((total, line) => total + numberValue(line.heures), 0));
    const autresFrais = round2(interventions.reduce((total, line) => total + numberValue(line.autres_frais), 0));
    const primeEdl = round2(primes.reduce((total, line) => total + numberValue(line.prime), 0));
    const primeResponsabilite = numberValue(form.elements.prime_responsabilite.value);
    const baremeKm = Number(form.elements.bareme_km.value) || 0.636;
    const travel = travelTotals(interventions, baremeKm);
    const { km, fraisKm } = travel;
    const brute = round2(encaissementsHt * 0.07);
    const nette = round2(brute * 0.70);
    const total = round2(
      encaissementsHt * 0.07 * 0.70 +
      km * baremeKm +
      primeEdl +
      primeResponsabilite +
      (form.elements.autres_frais_inclus_total.checked ? autresFrais : 0)
    );
    return { encaissements, interventions, primes, encaissementsHt, heures, ...travel, autresFrais, primeEdl, primeResponsabilite, baremeKm, brute, nette, total };
  }

  function readForm(form) {
    const fd = new FormData(form);
    const data = {};
    for (const [k, v] of fd.entries()) data[k] = v;
    form.querySelectorAll('input[type="checkbox"]').forEach((el) => { data[el.name] = el.checked; });
    return data;
  }

  function options(table, emptyLabel) {
    const rows = state.data[table] || [];
    return [{ value: "", label: emptyLabel || "-" }].concat(rows.map((r) => ({ value: r.id, label: localLabel(table, r.id) })));
  }

  function seedLocalIfEmpty() {
    if (localRead("locaux").length || localRead("locataires").length) return;
    const localId = uid();
    const locataireId = uid();
    localWrite("locaux", [{ id: localId, code_local: "E1", designation: "Local exemple", statut: "Loue", loyer_ht: 500, tva_loyer: 0, loyer_ttc: 500, charges_mensuelles: 50 }]);
    localWrite("locataires", [{ id: locataireId, type: "Particulier", nom: "DUPONT", prenom: "Jean", statut: "Actif" }]);
    localWrite("baux", [{ id: uid(), local_id: localId, locataire_id: locataireId, type_bail: "Commercial", date_debut: "2026-01-01", date_fin: "2026-12-31", loyer_ht: 500, tva: 0, charges_mensuelles: 50, statut: "Actif", renouvellement_auto: false }]);
  }

  async function notifyDeadlines() {
    if (!("Notification" in window) || Notification.permission !== "granted") return;
    const rows = expiringBaux();
    if (!rows.length || sessionStorage.getItem("ruvelon_notified_baux") === today()) return;
    const urgent = rows.filter((b) => b._deadline.level === "expired" || b._deadline.level === "three").length;
    const warning = rows.filter((b) => b._deadline.level === "six").length;
    const parts = [];
    if (urgent) parts.push(`${urgent} urgent(s) ou a moins de 3 mois`);
    if (warning) parts.push(`${warning} entre 3 et 6 mois`);
    new Notification("SCI RUVELON - echeances de baux", { body: parts.join(" ; ") });
    sessionStorage.setItem("ruvelon_notified_baux", today());
  }

  window.App = {
    closeModal,
    go(route) {
      state.route = route;
      if (route === "comptes-rendus") { state.reportId = ""; return loadReportRecords(); }
      if (route === "energie" || route === "entretien") return loadAnnualRecords(route);
      render();
    },
    setAnnualYear(kind,year) {
      if (!state.annualLedgers[kind]) return;
      state.annualLedgers[kind].year = String(year);
      render();
    },
    openAnnualForm(kind,year,postKey) {
      if (!ensureAdminAction() || !state.annualLedgers[kind]) return;
      const config = annualLedgerConfig(kind);
      const records = annualByYear(kind);
      const existing = records.get(year);
      const posts = postKey ? config.posts.filter(([key]) => key === postKey) : config.posts;
      if (postKey && (!existing || !posts.length)) return;
      const next = records.size ? Math.max(...records.keys())+1 : Number(currentMonth().slice(0,4));
      const fields = [{type:"number",name:"annee",label:"Année",value:existing ? year : Math.min(next,2100),min:2000,max:2100,step:"1",required:true,readonly:Boolean(existing)}];
      for (const [key,label] of posts) {
        for (const [field,period] of [["prevision","Prévision"],["reel","Réel"]]) {
          const name = key+"_"+field;
          const post = existing?.posts[key];
          fields.push({type:"number",name,label:`${label} · ${period} (${config.unit})`,value:post?.[field] ?? "",step:"0.01",min:"0",
            oninput:kind==="entretien" ? `App.syncAnnualVat(this,'${name}_ttc',false)` : ""});
          if (kind==="entretien") fields.push({type:"number",name:name+"_ttc",label:`${label} · ${period} (€ TTC)`,
            value:maintenanceTtc(post?.[field],post?.[field+"_ttc"]) ?? "",step:"0.01",min:"0",oninput:`App.syncAnnualVat(this,'${name}',true)`});
        }
      }
      const title = postKey ? `${posts[0][1]} · ${year}` : existing ? `${config.title} ${year}` : "Ajouter une année";
      openModal(kind==="entretien" ? title+" · TVA 20 %" : title,formHtml(fields,"documents","saveAnnual"));
      const form = $("#edit-form");
      form.dataset.annualKind = kind;
      form.dataset.annualYear = existing ? String(year) : "";
      form.dataset.annualId = existing?.id || "";
      form.dataset.annualPost = postKey || "";
      if (postKey) form.elements[postKey+(kind==="entretien"?"_reel_ttc":"_reel")].focus();
    },
    syncAnnualVat(input,target,gross) {
      const other = input.form.elements[target];
      const cents = Math.round(input.valueAsNumber*100);
      other.value = Number.isFinite(cents) && cents >= 0 ? (Math.round(gross?cents*5/6:cents*6/5)/100).toFixed(2) : "";
    },
    async saveAnnual(form) {
      if (!ensureAdminAction() || !form.reportValidity()) return;
      const submit = form.querySelector('[type="submit"]');
      if (submit.disabled) return;
      submit.disabled = true;
      try {
        const kind = form.dataset.annualKind;
        const ledger = state.annualLedgers[kind];
        if (!ledger) throw new Error("Rubrique introuvable.");
        const config = annualLedgerConfig(kind);
        const data = new FormData(form);
        const annee = Number(data.get("annee"));
        if (!Number.isInteger(annee) || annee < 2000 || annee > 2100) throw new Error("Année invalide.");
        const current = annualByYear(kind,await dbDocumentMetadata([config.category])).get(annee);
        if (current && !form.dataset.annualYear) throw new Error("Cette année existe déjà. Ouvrez sa fiche pour la modifier.");
        if (form.dataset.annualYear && (String(annee)!==form.dataset.annualYear || !current || (current.id || "")!==form.dataset.annualId)) {
          throw new Error("Cette année a changé. Rouvrez la fiche avant d’enregistrer.");
        }
        const value = name => data.get(name) === "" ? null : money(data.get(name));
        const postKey = form.dataset.annualPost;
        const posts = postKey ? config.posts.filter(([key]) => key === postKey) : config.posts;
        if (!posts.length || (postKey && !current)) throw new Error("Poste introuvable.");
        const postes = {...current?.savedPosts};
        for (const [key] of posts) {
          postes[key] = {prevision:value(key+"_prevision"),reel:value(key+"_reel")};
          if (kind==="entretien") {
            postes[key].prevision_ttc = value(key+"_prevision_ttc");
            postes[key].reel_ttc = value(key+"_reel_ttc");
          }
        }
        await dbSave("documents",{...(current?.id ? {id:current.id} : {}),nom_fichier:`${config.title} ${annee}`,categorie:config.category,url:"",observations:JSON.stringify({annee,postes})});
        ledger.year = String(annee);
        closeModal();
        await loadAnnualRecords(kind);
        toast("Dépenses enregistrées");
      } catch (error) { toast(error.message || "Enregistrement impossible."); }
      finally { submit.disabled = false; }
    },
    viewReport(id) { state.reportId = id; render(); },
    openReportForm() {
      if (!ensureAdminAction()) return;
      openModal("Ajouter un compte rendu", `<form data-action="saveReport" class="form-grid">
        <label class="field-full">Titre<input name="title" required maxlength="160"></label>
        <label>Date de réunion<input type="date" name="date" value="${today()}" required></label>
        <label>Document PDF<input type="file" name="pdf" accept=".pdf,application/pdf" required></label>
        <div class="form-actions"><button type="button" class="secondary" onclick="App.closeModal()">Annuler</button><button class="primary" type="submit">Enregistrer</button></div>
      </form>`);
    },
    openReportNote(id) {
      if (!ensureAdminAction() || !findReport(id)) return;
      openModal("Ajouter une annotation", `<form data-action="saveReport" class="form-grid">
        <input type="hidden" name="report_id" value="${escapeHtml(id)}">
        <label class="field-full">Annotation<textarea name="text" rows="5" required maxlength="5000"></textarea></label>
        <div class="form-actions"><button type="button" class="secondary" onclick="App.closeModal()">Annuler</button><button class="primary" type="submit">Enregistrer</button></div>
      </form>`);
    },
    async saveReport(form) {
      if (!ensureAdminAction() || !form.reportValidity()) return;
      const submit = form.querySelector('[type="submit"]');
      if (submit.disabled) return;
      submit.disabled = true;
      try {
        const data = new FormData(form);
        const reportId = data.get("report_id");
        if (reportId) {
          const report = findReport(reportId);
          const text = String(data.get("text") || "").trim();
          if (!report || !text || text.length > 5000) throw new Error("Saisissez une annotation valide.");
          await dbSave("documents", { nom_fichier: "Annotation", categorie: REPORT_NOTE_CATEGORY, url: "", observations: JSON.stringify({report_id: report.id, text, author: state.profile?.nom || state.user?.email || ""}) });
        } else {
          const title = String(data.get("title") || "").trim();
          if (!title || title.length > 160) throw new Error("Saisissez un titre valide.");
          const file = data.get("pdf");
          const url = await readReportPdf(file);
          await dbSave("documents", { nom_fichier: file.name, categorie: REPORT_CATEGORY, url, observations: JSON.stringify({title,date:data.get("date")}) });
        }
        closeModal();
        await loadReportRecords();
        toast(reportId ? "Annotation enregistrée" : "Compte rendu enregistré");
      } catch (error) { toast(error.message || "Enregistrement impossible."); }
      finally { submit.disabled = false; }
    },
    downloadReport(id, button) {
      if (findReport(id)) return downloadStoredPdf({id,category:REPORT_CATEGORY,maxBytes:REPORT_MAX_BYTES},button);
    },
    downloadLease(id, button) {
      const bail = state.data.baux.find(b => b.id === id);
      if (bail) return downloadStoredPdf({id:leaseDocumentId(bail),category:"bail_pdf",bailId:id,maxBytes:LEASE_MAX_BYTES},button);
    },
    setMonth(v) { state.month = v || currentMonth(); render(); },
    setYear(v) { state.year = String(v || new Date().getFullYear()); render(); },
    filterTravaux(field, value) {
      if (!["travauxYear", "travauxStatus", "travauxSearch", "travauxOrigin", "entretienCategorie"].includes(field)) return;
      state[field] = value;
      render();
    },
    filterEtudes(value) { state.etudeRecherche = value.trim(); render(); },
    installApp() { $("#install-btn").click(); },
    async copyInstallLink() {
      const installUrl = `${location.origin}${location.pathname}`;
      try {
        await navigator.clipboard.writeText(installUrl);
        toast("Lien copie.");
      } catch (error) {
        openModal("Lien de l'application", `<div class="notice info">${escapeHtml(installUrl)}</div>`);
      }
    },
    generateRents,
    recalcBailForm(form) {
      const total = Number(form.elements.total_ttc_charges.value) || 0;
      const charges = Number(form.elements.charges_mensuelles.value) || 0;
      form.elements.charges_mensuelles.setCustomValidity(charges > total ? "Les charges ne peuvent pas depasser le total TTC." : "");
      const ttc = money(total - charges);
      const ht = round2(ttc / 1.2);
      form.elements.loyer_ttc_calcule.value = ttc.toFixed(2);
      form.elements.loyer_ht.value = ht.toFixed(2);
      form.elements.tva.value = 20;
      form.elements.tva_montant_calcule.value = round2(ttc - ht).toFixed(2);
    },
    openPasswordChange() {
      if (!sb) {
        toast("Changement possible uniquement avec la base en ligne.");
        return;
      }
      openModal("Changer le mot de passe", formHtml([
        { type: "password", name: "new_password", label: "Nouveau mot de passe", value: "", min: "8" },
        { type: "password", name: "confirm_password", label: "Confirmer le mot de passe", value: "", min: "8" }
      ], "", "savePassword"));
    },
    fillLoyerFromBail(bailId, form) {
      const d = loyerFromBail(bailId);
      if (!d || !form) return;
      Object.keys(d).forEach((name) => {
        if (form.elements[name]) form.elements[name].value = d[name] ?? "";
      });
      const bail = state.data.baux.find((x) => x.id === bailId);
      if (form.elements.tva_taux) form.elements.tva_taux.value = bail ? Number(bail.tva || 0) : 0;
      if (form.elements.total_paye) form.elements.total_paye.value = 0;
      if (form.elements.paiement_controle) form.elements.paiement_controle.checked = false;
      this.recalcLoyerForm(form, "bail");
    },
    recalcLoyerForm(form, source) {
      if (!form) return;
      const loyerHt = money(form.elements.loyer_ht ? form.elements.loyer_ht.value : 0);
      const tvaRate = Math.max(0, Number(form.elements.tva_taux ? form.elements.tva_taux.value : 0) || 0);
      let tva = money(form.elements.tva ? form.elements.tva.value : 0);
      let loyerTtc = money(form.elements.loyer_ttc ? form.elements.loyer_ttc.value : 0);
      const charges = money(form.elements.charges_mensuelles ? form.elements.charges_mensuelles.value : 0);

      if (source === "ht" && tvaRate > 0) {
        tva = money(loyerHt * tvaRate / 100);
        if (form.elements.tva) form.elements.tva.value = tva.toFixed(2);
      }

      if (source === "ht" || source === "tva" || source === "bail") {
        loyerTtc = money(loyerHt + tva);
        if (form.elements.loyer_ttc) form.elements.loyer_ttc.value = loyerTtc.toFixed(2);
      }

      const totalAttendu = money(loyerTtc + charges);
      if (source !== "manualTotal" && form.elements.total_attendu) {
        form.elements.total_attendu.value = totalAttendu.toFixed(2);
      }

      const total = money(form.elements.total_attendu ? form.elements.total_attendu.value : totalAttendu);
      if (source === "paidCheck" && form.elements.paiement_controle && form.elements.paiement_controle.checked && form.elements.total_paye) {
        form.elements.total_paye.value = total.toFixed(2);
      }
      if (form.elements.total_paye && money(form.elements.total_paye.value) > total) {
        form.elements.total_paye.value = total.toFixed(2);
      }
    },
    addRemunerationLine(kind, form) {
      const list = form && form.querySelector(`[data-detail-list="${kind}"]`);
      if (!list) return;
      list.insertAdjacentHTML("beforeend", remunerationLineHtml(kind, {}));
      this.recalcRemunerationForm(form);
    },
    removeRemunerationLine(button) {
      const form = button && button.form;
      const line = button && button.closest("[data-detail-kind]");
      if (line) line.remove();
      if (form) this.recalcRemunerationForm(form);
    },
    recalcRemunerationForm(form) {
      if (!form) return;
      const automatic = form.elements.encaissements_source.value === "pointage";
      const receiptList = form.querySelector('[data-detail-list="encaissements"]');
      if (automatic) {
        const previous = state.data.remuneration_gerant.find(r => r.id === form.elements.id.value) || {};
        const [receipt] = pointedReceipts(form.elements.mois.value, previous);
        receiptList.innerHTML = `<div class="monthly-receipt" data-detail-kind="encaissements"><label>Total loyers HT du mois<input type="number" step="0.01" data-field="loyer_ht" value="${receipt.loyer_ht.toFixed(2)}" readonly></label><label>Total encaissé HT du mois<input type="number" step="0.01" data-field="encaissement_ht" value="${receipt.encaissement_ht.toFixed(2)}" readonly></label><input type="hidden" data-field="observations" value="${escapeHtml(receipt.observations)}"></div><div class="table-sub">${escapeHtml(receipt.observations)}</div>`;
      }
      if (!automatic && !receiptList.querySelector('[data-detail-kind="encaissements"]')) receiptList.innerHTML = remunerationLineHtml("encaissements", {});
      receiptList.querySelectorAll('input').forEach(input => { input.readOnly = automatic; });
      receiptList.querySelectorAll('.detail-remove').forEach(button => { button.hidden = automatic; });
      receiptList.closest('section').querySelector('.detail-section-head button').hidden = automatic;
      const rate = Number(form.elements.bareme_km.value) || 0.636;
      form.querySelectorAll('[data-detail-kind="interventions"]').forEach(line => {
        if (/visit/i.test(line.querySelector('[data-field="activite"]').value)) line.querySelector('[data-field="motif_deplacement"]').value = "visite";
        const visit = isVisit({ activite: line.querySelector('[data-field="activite"]').value, motif_deplacement: line.querySelector('[data-field="motif_deplacement"]').value });
        const checkbox = line.querySelector('[data-field="non_facturable"]');
        if (visit) checkbox.checked = true;
        else if (checkbox.disabled) checkbox.checked = false;
        checkbox.disabled = visit;
        const distance = numberValue(line.querySelector('[data-field="km"]').value);
        line.querySelector('[data-travel="sci"]').textContent = euro(checkbox.checked ? 0 : round2(distance * rate));
        line.querySelector('[data-travel="perso"]').textContent = euro(checkbox.checked ? round2(distance * PERSONAL_VEHICLE_COST_PER_KM) : 0);
      });
      const totals = remunerationDetailTotals(form, true);
      const values = {
        encaissements: euro(totals.encaissementsHt),
        factures_ht: euro(sum(totals.encaissements, "loyer_ht")),
        brute: euro(totals.brute),
        nette: euro(totals.nette),
        heures: totals.heures.toFixed(2),
        frais_km: euro(totals.fraisKm),
        km_total: totals.kmTotal.toFixed(1),
        km_sci: totals.km.toFixed(1),
        km_perso: totals.kmPerso.toFixed(1),
        frais_perso: euro(totals.fraisPerso),
        cout_deplacements: euro(totals.coutDeplacements),
        primes: euro(totals.primeEdl + totals.primeResponsabilite),
        autres: euro(totals.autresFrais),
        total: euro(totals.total)
      };
      Object.entries(values).forEach(([name, value]) => {
        const target = form.querySelector(`[data-recap="${name}"]`);
        if (target) target.textContent = value;
      });
    },
    async requestNotifications() {
      if (!("Notification" in window)) return toast("Notifications non disponibles sur ce navigateur.");
      const result = await Notification.requestPermission();
      toast(result === "granted" ? "Notifications activees." : "Notifications refusees.");
      notifyDeadlines();
    },
    async toggleLoyer(id, field) {
      if (!ensureAdminAction()) return;
      const row = state.data.loyers_mensuels.find((r) => r.id === id);
      if (!row) return;
      const value = !row[field];
      const update = { ...row, [field]: value };
      if (field === "facture_meg_faite") update.date_facture_meg = value ? today() : null;
      if (field === "paiement_controle") {
        update.date_paiement_controle = value ? today() : null;
        update.total_paye = value ? update.total_attendu : 0;
      }
      await dbSave("loyers_mensuels", update);
      await refresh("Pointage mis a jour");
    },
    async deleteRow(table, id) {
      if (!await dbDelete(table, id)) return;
      await refresh("Ligne supprimee");
    },
    async deleteTravaux(id) {
      if (!ensureAdminAction()) return;
      const row = state.data.travaux.find(t => t.id === id);
      if (!row) return;
      try {
        const deleted = await dbDelete("travaux", id, `Supprimer les travaux « ${row.titre} » ?\nCette suppression est définitive. Les fichiers associés ne sont pas supprimés.`);
        if (deleted) await refresh("Travaux supprimés");
      } catch (error) { toast(error.message || "Suppression impossible"); }
    },
    openLoyer(id) {
      if (!ensureAdminAction()) return;
      const r = state.data.loyers_mensuels.find((x) => x.id === id) || { mois: monthDate(state.month), total_paye: 0, total_attendu: 0 };
      const bail = state.data.baux.find((x) => x.id === r.bail_id);
      const tvaTaux = bail ? Number(bail.tva || 0) : (Number(r.loyer_ht || 0) ? round2((Number(r.tva || 0) / Number(r.loyer_ht || 0)) * 100) : 0);
      openModal("Loyer / pointage", formHtml([
        { type: "hidden", name: "id", value: r.id || "" },
        { type: "hidden", name: "tva_taux", value: tvaTaux },
        { type: "date", name: "mois", label: "Mois", value: r.mois || monthDate(state.month) },
        { type: "select", name: "bail_id", label: "Bail actif", value: r.bail_id, options: bailOptions("Choisir un bail"), onchange: "App.fillLoyerFromBail(this.value, this.form)" },
        { type: "select", name: "local_id", label: "Local", value: r.local_id, options: options("locaux", "Choisir") },
        { type: "select", name: "locataire_id", label: "Locataire", value: r.locataire_id, options: options("locataires", "Choisir") },
        { type: "number", step: "0.01", min: "0", name: "loyer_ht", label: "Loyer HT", value: r.loyer_ht || 0, oninput: "App.recalcLoyerForm(this.form, 'ht')" },
        { type: "number", step: "0.01", min: "0", name: "tva", label: "TVA montant", value: r.tva || 0, oninput: "App.recalcLoyerForm(this.form, 'tva')" },
        { type: "number", step: "0.01", min: "0", name: "loyer_ttc", label: "Loyer TTC", value: r.loyer_ttc || r.loyer_ht || 0, oninput: "App.recalcLoyerForm(this.form, 'ttc')" },
        { type: "number", step: "0.01", min: "0", name: "charges_mensuelles", label: "Charges", value: r.charges_mensuelles || 0, oninput: "App.recalcLoyerForm(this.form, 'total')" },
        { type: "number", step: "0.01", min: "0", name: "total_attendu", label: "Total attendu", value: r.total_attendu || 0, oninput: "App.recalcLoyerForm(this.form, 'manualTotal')" },
        { type: "number", step: "0.01", min: "0", name: "total_paye", label: "Total paye", value: r.total_paye || 0, oninput: "App.recalcLoyerForm(this.form, 'paid')" },
        { type: "checkbox", name: "facture_meg_faite", label: "Facture faite dans MEG", value: r.facture_meg_faite },
        { type: "checkbox", name: "paiement_controle", label: "Paiement controle", value: r.paiement_controle, onchange: "App.recalcLoyerForm(this.form, 'paidCheck')" },
        { type: "textarea", name: "observations", label: "Observations", value: r.observations || "" }
      ], "loyers_mensuels"));
    },
    openLocal(id) {
      if (!ensureAdminAction()) return;
      const r = state.data.locaux.find((x) => x.id === id) || { statut: "Disponible", tva_loyer: 0 };
      openModal("Local", formHtml([
        { type: "hidden", name: "id", value: r.id || "" },
        { name: "code_local", label: "Code local", value: r.code_local || "" },
        { name: "designation", label: "Designation", value: r.designation || "" },
        { name: "niveau", label: "Niveau", value: r.niveau || "" },
        { type: "number", step: "0.01", min: "0", name: "surface_m2", label: "Surface m2", value: r.surface_m2 || 0 },
        { type: "select", name: "statut", label: "Statut", value: r.statut, options: ["Disponible", "Loue", "Reserve", "En travaux", "Partie commune", "Archive"].map((x) => ({ value: x, label: x })) },
        { type: "number", step: "0.01", name: "loyer_ht", label: "Loyer HT", value: r.loyer_ht || 0 },
        { type: "number", step: "0.01", name: "tva_loyer", label: "TVA %", value: r.tva_loyer || 0 },
        { type: "number", step: "0.01", name: "loyer_ttc", label: "Loyer TTC", value: r.loyer_ttc || r.loyer_ht || 0 },
        { type: "number", step: "0.01", name: "charges_mensuelles", label: "Charges mensuelles", value: r.charges_mensuelles || 0 },
        { type: "number", step: "0.01", min: "0", name: "depot_garantie", label: "Depot de garantie", value: r.depot_garantie || 0 },
        { type: "textarea", name: "observations", label: "Observations", value: r.observations || "" }
      ], "locaux"));
    },
    openLocataire(id) {
      if (!ensureAdminAction()) return;
      const r = state.data.locataires.find((x) => x.id === id) || { statut: "Actif" };
      openModal("Locataire", formHtml([
        { type: "hidden", name: "id", value: r.id || "" },
        { name: "nom", label: "Nom", value: r.nom || "" },
        { name: "prenom", label: "Prenom", value: r.prenom || "" },
        { name: "raison_sociale", label: "Raison sociale", value: r.raison_sociale || "" },
        { name: "activite", label: "Activite", value: r.activite || "" },
        { name: "telephone", label: "Telephone", value: r.telephone || "" },
        { name: "email", label: "Email", value: r.email || "" },
        { name: "adresse", label: "Adresse", value: r.adresse || "" },
        { name: "code_postal", label: "Code postal", value: r.code_postal || "" },
        { name: "ville", label: "Ville", value: r.ville || "" },
        { type: "select", name: "statut", label: "Statut", value: r.statut, options: ["Actif", "Ancien", "Prospect"].map((x) => ({ value: x, label: x })) },
        { type: "textarea", name: "observations", label: "Observations", value: r.observations || "" }
      ], "locataires"));
    },
    openBail(id) {
      if (!ensureAdminAction()) return;
      const r = state.data.baux.find((x) => x.id === id) || { statut: "Actif", type_bail: "Commercial", tva: 20 };
      const totalTtc = money(money(Number(r.loyer_ht || 0) * (1 + Number(r.tva || 0) / 100)) + Number(r.charges_mensuelles || 0));
      openModal("Bail", formHtml([
        { type: "hidden", name: "id", value: r.id || "" },
        { type: "select", name: "local_id", label: "Local", value: r.local_id, options: options("locaux", "Choisir") },
        { type: "select", name: "locataire_id", label: "Locataire et telephone", value: r.locataire_id, options: bailTenantOptions("Choisir") },
        { name: "type_bail", label: "Type bail", value: r.type_bail || "" },
        { type: "date", name: "date_debut", label: "Debut", value: r.date_debut || "" },
        { type: "date", name: "date_fin", label: "Fin", value: r.date_fin || "" },
        { type: "number", step: "0.01", min: "0", required: true, name: "total_ttc_charges", label: "Total TTC charges comprises", value: totalTtc, oninput: "App.recalcBailForm(this.form)" },
        { type: "number", step: "0.01", min: "0", required: true, name: "charges_mensuelles", label: "Charges TTC", value: r.charges_mensuelles || 0, oninput: "App.recalcBailForm(this.form)" },
        { type: "number", step: "0.01", name: "loyer_ttc_calcule", label: "Loyer TTC hors charges", value: 0, readonly: true },
        { type: "number", step: "0.01", name: "loyer_ht", label: "Loyer HT hors charges", value: 0, readonly: true },
        { type: "number", name: "tva", label: "TVA (%)", value: 20, readonly: true },
        { type: "number", step: "0.01", name: "tva_montant_calcule", label: "TVA sur le loyer", value: 0, readonly: true },
        { type: "number", step: "0.01", min: "0", name: "depot_garantie", label: "Depot de garantie", value: r.depot_garantie || 0 },
        { type: "checkbox", name: "renouvellement_auto", label: "Renouvellement automatique", value: r.renouvellement_auto },
        { type: "select", name: "statut", label: "Statut", value: r.statut, options: ["Actif", "En preparation", "Renouvele", "Resilie", "Archive"].map((x) => ({ value: x, label: x })) },
        { name: "document_url", label: leaseDocumentId(r) ? "PDF rattaché" : "Lien du bail", value: r.document_url || "", readonly: Boolean(leaseDocumentId(r)) },
        { type: "textarea", name: "observations", label: "Observations", value: r.observations || "" }
      ], "baux"));
      this.recalcBailForm(document.getElementById("edit-form"));
    },
    setTravauxPlanning(form) {
      const unknown = form.elements.planification_travaux.value === "indefini";
      ["annee_cible", "date_prevue"].forEach(name => { form.elements[name].disabled = unknown; });
    },
    openTravaux(id) {
      if (!ensureAdminAction()) return;
      const r = state.data.travaux.find((x) => x.id === id) || { statut: travauxStatuses[0], priorite: "P4" };
      const d = travauxDetails(r);
      if (d.rubrique === "etude") return this.openEtude(id);
      const rubrique = d.rubrique === "entretien" || (!r.id && state.route === "entretien") ? "entretien" : "travaux";
      openModal(rubrique === "entretien" ? "Entretien" : "Travaux", formHtml([
        { type: "hidden", name: "id", value: r.id || "" },
        { name: "titre", label: "Intitulé", value: r.titre || "", required: true },
        { type: "select", name: "rubrique_travaux", label: "Rubrique", value: rubrique, options: [{value:"travaux",label:"Travaux"},{value:"entretien",label:"Entretien"}], onchange:"App.setTravauxRubrique(this.form)" },
        { type: "select", name: "categorie_entretien", label: "Catégorie d’entretien", value: d.entretien_categorie || state.entretienCategorie || "", options: [{value:"",label:"Choisir une catégorie"},...Object.entries(entretienCategories).map(([value,label])=>({value,label}))], required:true },
        { type: "select", name: "frequence_entretien", label: "Fréquence", value: d.entretien_frequence || "", options: [{value:"",label:"À définir"},...entretienFrequences.map(x=>({value:x,label:x}))] },
        { type: "number", min: "0", step: "0.01", name: "budget_entretien", label: "Budget sans base HT/TTC (€)", value: d.budget_indique ?? "" },
        { type: "checkbox", name: "exclure_budget_entretien", label: "Exclure l’estimation du prévisionnel", value: d.entretien_exclure_budget === true },
        { type: "select", name: "origine_travaux", label: "Origine", value: travauxOrigin(r), options: Object.entries(travauxOrigins).map(([value,label])=>({value,label})) },
        { type: "select", name: "planification_travaux", label: "Planification", value: d.annee || r.date_prevue ? "planifie" : "indefini", options: [{ value: "indefini", label: "À définir" }, { value: "planifie", label: "Planifié" }], onchange: "App.setTravauxPlanning(this.form)" },
        { type: "number", min: "2000", step: "1", name: "annee_cible", label: "Année prévue", value: d.annee || "" },
        { name: "localisation_travaux", label: "Lieu / sous-zone", value: d.localisation || "" },
        { type: "select", name: "local_id", label: "Local", value: r.local_id, options: options("locaux", "General") },
        { type: "select", name: "priorite", label: "Priorité", value: r.priorite, options: [...new Set(["P1","P2","P3","P4","P5","P6",r.priorite])].filter(Boolean).map((x) => ({ value: x, label: ({P1:"P1 - Sécurité",P2:"P2 - Urgent",P3:"P3 - Important",P4:"P4 - Programmé",P5:"P5 - Pluriannuel",P6:"P6 - Long terme"})[x] || x })) },
        { type: "select", name: "statut", label: "Avancement", value: r.statut, options: [...new Set([...travauxStatuses, r.statut])].filter(Boolean).map((x) => ({ value: x, label: x })) },
        { name: "entreprise", label: "Entreprise / prestataire", value: r.entreprise || "" },
        { type: "number", min: "0", step: "0.01", name: "montant_estime", label: rubrique === "entretien" ? "Budget HT (annuel si récurrent)" : "Estimation HT (€)", value: r.montant_estime || 0 },
        { type: "number", min: "0", step: "0.01", name: "devis_ht_travaux", label: "Devis HT (€)", value: d.devis_ht ?? "" },
        { type: "number", min: "0", step: "0.01", name: "montant_reel", label: "Réalisé HT (€)", value: r.montant_reel || 0 },
        { type: "date", name: "date_prevue", label: "Date prévue (si connue)", value: r.date_prevue || "" },
        { type: "date", name: "date_realisation", label: "Date de réception", value: r.date_realisation || "" },
        { type: "textarea", name: "description", label: "Description", value: r.description || "" },
        { type: "textarea", name: "note_matt_travaux", label: "Annotation Matthieu / arbitrage", value: d.note_matt || "" },
        { type: "textarea", name: "notes_travaux", label: "Observations / décisions", value: d.notes || "" }
      ], "travaux"));
      this.setTravauxPlanning(document.getElementById("edit-form"));
      this.setTravauxRubrique(document.getElementById("edit-form"));
    },
    setTravauxRubrique(form) {
      const entretien = form.elements.rubrique_travaux.value === "entretien";
      const estimateLabel = form.elements.montant_estime.closest("label");
      estimateLabel.firstChild.textContent = entretien ? "Budget HT (annuel si récurrent)" : "Estimation HT (€)";
      for (const name of ["categorie_entretien","frequence_entretien","budget_entretien","exclure_budget_entretien"]) {
        const field = form.elements[name];
        field.disabled = !entretien;
        field.closest("label").hidden = !entretien;
      }
    },
    openEtude(id) {
      if (!ensureAdminAction()) return;
      const row = id ? state.data.travaux.find(t=>t.id===id) : {statut:etudeStatuses[0]};
      if (!row) return;
      const d = travauxDetails(row);
      if (id && d.rubrique!=="etude") return;
      const statuses = [...new Set([...etudeStatuses,row.statut])].filter(Boolean);
      openModal(id ? "Modifier l’étude" : "Ajouter une étude",formHtml([
        {type:"hidden",name:"id",value:row.id || ""},
        {name:"titre",label:"Intitulé de l’étude",value:row.titre || "",required:true},
        {type:"select",name:"statut",label:"Statut",value:row.statut,options:statuses.map(value=>({value,label:value}))},
        {type:"textarea",name:"description",label:"Problématique concernée",value:row.description || "",required:true},
        {type:"select",name:"local_id",label:"Local",value:row.local_id,options:options("locaux","Ensemble du bâtiment")},
        {name:"localisation",label:"Lieu / sous-zone",value:d.localisation || ""},
        {name:"entreprise",label:"Intervenant",value:row.entreprise || ""},
        {name:"periode",label:"Précision sur la période",value:d.etude_periode || ""},
        {type:"date",name:"debut",label:"Début de l’étude",value:d.etude_debut || ""},
        {type:"date",name:"fin",label:"Fin / échéance de l’étude",value:d.etude_fin || ""},
        {type:"number",name:"cout_estime",label:"Coût estimé de l’étude (€ HT)",value:d.etude_cout_estime_ht ?? "",step:"0.01",min:"0"},
        {type:"number",name:"cout_reel",label:"Coût réel de l’étude (€ HT)",value:d.etude_cout_reel_ht ?? "",step:"0.01",min:"0"},
        {type:"textarea",name:"observations",label:"Observations détaillées",value:d.etude_observations || d.notes || ""}
      ],"travaux","saveEtude"));
    },
    async saveEtude(form) {
      if (!ensureAdminAction() || !form.reportValidity()) return;
      const submit = form.querySelector('[type="submit"]');
      if (submit.disabled) return;
      submit.disabled = true;
      try {
        const data = readForm(form);
        const row = data.id ? state.data.travaux.find(t=>t.id===data.id) : {};
        if (!row || (data.id && travauxDetails(row).rubrique!=="etude")) throw new Error("Étude introuvable.");
        if (!data.titre.trim() || !data.description.trim()) throw new Error("Indiquez un intitulé et une problématique.");
        if (data.debut && data.fin && data.fin<data.debut) throw new Error("L’échéance ne peut pas précéder le début de l’étude.");
        const detail = {...travauxDetails(row),version_travaux:1,rubrique:"etude",localisation:data.localisation,
          etude_debut:data.debut || null,etude_fin:data.fin || null,etude_periode:data.periode,
          etude_cout_estime_ht:data.cout_estime==="" ? null : money(data.cout_estime),
          etude_cout_reel_ht:data.cout_reel==="" ? null : money(data.cout_reel),etude_observations:data.observations};
        await dbSave("travaux",{...(data.id ? {id:data.id} : {}),titre:data.titre.trim(),description:data.description.trim(),local_id:data.local_id || null,
          entreprise:data.entreprise,statut:data.statut,observations:JSON.stringify(detail)});
        state.data.travaux = await dbList("travaux");
        closeModal();
        render();
        toast("Étude enregistrée");
      } catch (error) { toast(error.message || "Enregistrement impossible."); }
      finally { submit.disabled = false; }
    },
    async openRemuneration(id) {
      if (!ensureAdminAction()) return;
      try { state.data.loyers_mensuels = await dbList("loyers_mensuels"); }
      catch (error) { toast(error.message || "Impossible de charger le pointage du mois"); return; }
      try { state.data.baux = await dbList("baux"); }
      catch (error) { toast(error.message || "Impossible de charger les loyers habituels"); return; }
      const requestedMonth = `${state.year}-${state.month.slice(5, 7)}-01`;
      const r = state.data.remuneration_gerant.find((x) => x.id === id)
        || state.data.remuneration_gerant.find((x) => x.mois === requestedMonth)
        || { mois: requestedMonth, bareme_km: 0.636, autres_frais_inclus_total: state.year !== "2026", prime_responsabilite: 0 };
      openModal(`Remuneration - ${monthLabel(r.mois)}`, remunerationFormHtml(r));
      this.recalcRemunerationForm(document.getElementById("edit-form"));
    },
    async prepareRemunerationYear() {
      if (!ensureAdminAction()) return;
      for (let i = 1; i <= 12; i++) {
        const mois = `${state.year}-${String(i).padStart(2, "0")}-01`;
        if (!state.data.remuneration_gerant.some((r) => r.mois === mois)) {
          await dbSave("remuneration_gerant", { annee: Number(state.year), mois, autres_frais_inclus_total: state.year !== "2026" });
        }
      }
      await refresh("Mois crees");
    },
    async saveRemuneration(form) {
      if (!ensureAdminAction()) return;
      this.recalcRemunerationForm(form);
      const base = readForm(form);
      const totals = remunerationDetailTotals(form, true);
      const mois = monthDate(String(base.mois || "").slice(0, 7));
      const existing = state.data.remuneration_gerant.find((row) => row.mois === mois && row.id !== base.id);
      const notes = String(base.detail_notes || "").trim();
      const details = {
        version: 1,
        encaissements_source: base.encaissements_source,
        encaissements_manuel_volontaire: base.encaissements_source === "manuel",
        encaissements: totals.encaissements,
        interventions: totals.interventions,
        primes: totals.primes,
        notes
      };
      const data = {
        id: base.id || (existing && existing.id) || "",
        annee: Number(String(mois).slice(0, 4)),
        mois,
        encaissements_ht: totals.encaissementsHt,
        heures: totals.heures,
        km: totals.km,
        bareme_km: totals.baremeKm,
        loyer_reference_prime: round2(totals.primes.reduce((sum, line) => sum + numberValue(line.loyer_reference), 0)),
        situation_prime: totals.primeEdl ? "Montant manuel" : "Aucune prime",
        taux_prime: 0,
        prime_edl: totals.primeEdl,
        prime_responsabilite: totals.primeResponsabilite,
        autres_frais: totals.autresFrais,
        autres_frais_inclus_total: !!base.autres_frais_inclus_total,
        note_prime: totals.primes.map((line) => [line.date, line.local, line.type, euro(line.prime)].filter(Boolean).join(" - ")).join(" | "),
        observations: JSON.stringify(details)
      };
      await dbSave("remuneration_gerant", data);
      closeModal();
      await refresh("Suivi mensuel enregistre");
    },
    async savePassword(form) {
      if (!sb) return toast("Base en ligne non configuree.");
      const data = readForm(form);
      const password = String(data.new_password || "");
      const confirmPassword = String(data.confirm_password || "");
      if (password.length < 8) return toast("Le mot de passe doit faire au moins 8 caracteres.");
      if (password !== confirmPassword) return toast("Les deux mots de passe ne correspondent pas.");
      const { error } = await sb.auth.updateUser({ password });
      if (error) throw error;
      closeModal();
      toast("Mot de passe modifie.");
    },
    async save(table, form) {
      if (!ensureAdminAction()) return;
      const data = readForm(form);
      if (table === "travaux") {
        if (!form.reportValidity()) return;
        const previous = state.data.travaux.find(t => t.id === data.id);
        const details = travauxDetails(previous || {});
        details.version_travaux = 1;
        details.rubrique = data.rubrique_travaux === "entretien" ? "entretien" : "travaux";
        if (details.rubrique === "entretien") {
          details.entretien_categorie = data.categorie_entretien;
          details.entretien_frequence = data.frequence_entretien;
          details.budget_indique = data.budget_entretien === "" ? null : money(data.budget_entretien);
          details.entretien_exclure_budget = !!data.exclure_budget_entretien;
        }
        details.origine = Object.hasOwn(travauxOrigins,data.origine_travaux) ? data.origine_travaux : "nouveau";
        if (data.planification_travaux === "indefini") { data.annee_cible = ""; data.date_prevue = null; }
        details.annee = data.annee_cible ? Number(data.annee_cible) : (data.date_prevue ? Number(data.date_prevue.slice(0,4)) : null);
        details.localisation = data.localisation_travaux;
        details.devis_ht = data.devis_ht_travaux === "" ? null : money(data.devis_ht_travaux);
        details.note_matt = data.note_matt_travaux;
        details.notes = data.notes_travaux;
        data.observations = JSON.stringify(details);
        ["annee_cible","localisation_travaux","devis_ht_travaux","notes_travaux","note_matt_travaux","origine_travaux","planification_travaux","rubrique_travaux","categorie_entretien","frequence_entretien","budget_entretien","exclure_budget_entretien"].forEach(k => delete data[k]);
        data.local_id = data.local_id || null;
        data.date_prevue = data.date_prevue || null;
        data.date_realisation = data.date_realisation || null;
        data.montant_estime = money(data.montant_estime);
        data.montant_reel = money(data.montant_reel);
      }
      if (table === "baux") {
        this.recalcBailForm(form);
        if (!form.reportValidity()) return;
        data.loyer_ht = round2((Number(data.total_ttc_charges) - Number(data.charges_mensuelles)) / 1.2);
        data.charges_mensuelles = money(data.charges_mensuelles);
        data.tva = 20;
        delete data.total_ttc_charges;
        delete data.loyer_ttc_calcule;
        delete data.tva_montant_calcule;
      }
      if (table === "locaux") {
        const tvaRate = Math.max(0, Number(data.tva_loyer) || 0);
        const ht = money(data.loyer_ht);
        const ttc = money(data.loyer_ttc);
        if (ht > 0) data.loyer_ttc = money(ht * (1 + tvaRate / 100));
        else if (ttc > 0) {
          data.loyer_ht = money(ttc / (1 + tvaRate / 100));
          data.loyer_ttc = ttc;
        }
      }
      if (table === "loyers_mensuels") {
        data.mois = monthDate(String(data.mois).slice(0, 7));
        data.loyer_ht = money(data.loyer_ht);
        data.tva = money(data.tva);
        data.loyer_ttc = money(data.loyer_ttc || (data.loyer_ht + data.tva));
        data.charges_mensuelles = money(data.charges_mensuelles);
        data.total_attendu = money(data.total_attendu || (data.loyer_ttc + data.charges_mensuelles));
        data.total_paye = Math.min(money(data.total_paye), data.total_attendu);
        if (data.paiement_controle) data.total_paye = data.total_attendu;
        delete data.tva_taux;
      }
      await dbSave(table, data);
      closeModal();
      await refresh("Enregistre");
    },
    async signOut() {
      if (sb) await sb.auth.signOut();
      location.reload();
    }
  };

  function primeRate(situation) {
    if (situation === "Sans interruption") return 1;
    if (situation === "Interruption moins 1 mois") return 0.5;
    if (situation === "Interruption plus 1 mois") return 0.25;
    return 0;
  }

  initInstall();
  initAuth();
  $("#modal-close").addEventListener("click", closeModal);
  initSession().catch((err) => showLoginMessage(err.message || String(err)));
})();

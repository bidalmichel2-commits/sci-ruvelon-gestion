(function () {
  "use strict";

  const cfg = window.SCI_RUVELON_CONFIG || {};
  const hasConfig = !!(cfg.supabaseUrl && cfg.supabaseAnonKey && window.supabase);
  const sb = hasConfig ? window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey) : null;
  const tables = ["locaux", "locataires", "baux", "loyers_mensuels", "travaux", "remuneration_gerant"];
  const state = {
    route: "dashboard",
    month: currentMonth(),
    year: String(new Date().getFullYear()),
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

  async function dbDelete(table, id) {
    if (!state.isAdmin) {
      toast("Lecture seule: suppression non autorisee.");
      return;
    }
    if (!confirm("Supprimer cette ligne ?")) return;
    if (!sb) {
      localWrite(table, localRead(table).filter((r) => r.id !== id));
      return;
    }
    const { error } = await sb.from(table).delete().eq("id", id);
    if (error) throw error;
  }

  function stripGenerated(table, row) {
    const r = { ...row };
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
      btn.addEventListener("click", () => {
        state.route = btn.dataset.route;
        render();
      });
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
    if (state.route === "remuneration") screen.innerHTML = renderRemunerationScreen();
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
                <div class="chips"><span class="chip">HT ${euro(b.loyer_ht)}</span><span class="chip">Charges ${euro(b.charges_mensuelles)}</span>${isSecondaryBail(b) ? `<span class="chip">Local associe</span>` : ""}${b.renouvellement_auto ? `<span class="chip green">Renouv. auto</span>` : ""}</div>
                ${adminHtml(`<div class="actions"><button onclick="App.openBail('${b.id}')">Modifier</button></div>`)}
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
                  <td class="num">${euro(s.loyerHt)}</td><td class="num">${euro(s.charges)}</td><td class="num"><strong>${euro(s.loyerHt + s.charges)}</strong></td>
                  <td>${adminHtml(`<button class="table-action" onclick="App.openLocataire('${l.id}')">Modifier</button>`)}</td>
                </tr>`;
              }).join("")}</tbody>
            </table>
          </div>
          <div class="list mobile-list">${rows.length ? rows.map((l) => {
            const s = summaries.get(l.id);
            return `<div class="row">
              <div class="row-main"><div><div class="row-title">${escapeHtml(localLabel("locataires", l.id))}</div><div class="row-sub">${s.locaux.length ? escapeHtml(s.locaux.join(" + ")) : "Aucun local associe"}</div></div><div class="row-amount">${euro(s.loyerHt + s.charges)}</div></div>
              <div class="chips"><span class="chip">HT ${euro(s.loyerHt)}</span><span class="chip">Charges ${euro(s.charges)}</span>${s.renouvellementAuto ? `<span class="chip green">Renouv. auto</span>` : ""}</div>
              <div class="row-sub">Bail : ${fmtDate(s.dateDebut) || "-"} au ${fmtDate(s.dateFin) || "-"}</div>
              ${adminHtml(`<div class="actions"><button onclick="App.openLocataire('${l.id}')">Modifier</button></div>`)}
            </div>`;
          }).join("") : `<div class="empty">Aucun locataire</div>`}</div>
        </div>
      </div>`;
  }

  function renderPlus() {
    setTitle("Plus");
    return `
      <div class="desktop-wrap grid">
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
    const rows = state.data.travaux.sort((a, b) => String(a.priorite).localeCompare(String(b.priorite)));
    return `
      <div class="panel">
        <div class="panel-head"><h3>Travaux a suivre</h3>${adminHtml(`<button class="primary" onclick="App.openTravaux()">Ajouter</button>`)}</div>
        <div class="list">${rows.length ? rows.map((t) => `
          <div class="row">
            <div class="row-main"><div><div class="row-title">${escapeHtml(t.titre)}</div><div class="row-sub">${escapeHtml(localLabel("locaux", t.local_id))} - ${escapeHtml(t.statut)}</div></div><span class="chip ${t.priorite === "Urgente" || t.priorite === "Critique" ? "red" : "orange"}">${escapeHtml(t.priorite)}</span></div>
            ${adminHtml(`<div class="actions"><button onclick="App.openTravaux('${t.id}')">Modifier</button></div>`)}
          </div>`).join("") : `<div class="empty">Aucun travaux</div>`}</div>
      </div>`;
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

  function renderRemuneration() {
    const rows = state.data.remuneration_gerant.filter((r) => String(r.annee) === String(state.year)).sort((a, b) => String(a.mois).localeCompare(String(b.mois)));
    const total = sum(rows, "total_compte_courant");
    const ht = sum(rows, "encaissements_ht");
    const net = sum(rows, "remuneration_apres_abattement");
    const primes = round2(sum(rows, "prime_edl") + sum(rows, "prime_responsabilite"));
    const fraisKm = sum(rows, "frais_km");
    const heures = sum(rows, "heures");
    const autres = sum(rows, "autres_frais");
    return `
      <div class="panel">
        <div class="panel-head"><h3>Suivi remuneration gerant</h3>${adminHtml(`<button class="primary" onclick="App.openRemuneration()">Saisir un mois</button>`)}</div>
        <div class="toolbar"><input type="number" value="${state.year}" onchange="App.setYear(this.value)">${adminHtml(`<button class="secondary" onclick="App.prepareRemunerationYear()">Creer mois</button>`)}</div>
        <div class="cards remuneration-cards">
          <div class="card"><small>HT encaisse</small><strong>${euro(ht)}</strong></div>
          <div class="card"><small>Remuneration nette</small><strong>${euro(net)}</strong></div>
          <div class="card"><small>Primes</small><strong>${euro(primes)}</strong></div>
          <div class="card"><small>Frais km</small><strong>${euro(fraisKm)}</strong></div>
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
                <td class="num">${euro(values.fraisKm)}</td>
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
    if (f.type === "textarea") return `<label class="field-full">${escapeHtml(f.label)}<textarea name="${f.name}">${escapeHtml(f.value || "")}</textarea></label>`;
    if (f.type === "checkbox") return `<label class="notice info"><input type="checkbox" name="${f.name}" value="true" ${f.value ? "checked" : ""} ${attrs}> ${escapeHtml(f.label)}</label>`;
    return `<label>${escapeHtml(f.label)}<input type="${f.type || "text"}" name="${f.name}" value="${escapeHtml(f.value ?? "")}" ${attrs}></label>`;
  }

  function fieldAttrs(f) {
    return [
      f.step ? `step="${escapeHtml(f.step)}"` : "",
      f.min !== undefined ? `min="${escapeHtml(f.min)}"` : "",
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
      return `<div class="detail-line intervention-line" data-detail-kind="interventions">
        ${removeButton}
        <label>Date<input type="date" data-field="date" value="${escapeHtml(String(r.date || "").slice(0, 10))}"></label>
        <label>Activite<input data-field="activite" value="${escapeHtml(r.activite || "")}"></label>
        <label>Local<input data-field="local" value="${escapeHtml(r.local || "")}"></label>
        <label>Heures<input type="number" step="0.25" min="0" data-field="heures" value="${escapeHtml(r.heures || 0)}" oninput="App.recalcRemunerationForm(this.form)"></label>
        <label>Km aller-retour<input type="number" step="0.1" min="0" data-field="km" value="${escapeHtml(r.km || 0)}" oninput="App.recalcRemunerationForm(this.form)"></label>
        <label>Autres frais<input type="number" step="0.01" min="0" data-field="autres_frais" value="${escapeHtml(r.autres_frais || 0)}" oninput="App.recalcRemunerationForm(this.form)"></label>
        <label class="detail-note">Observation<input data-field="observations" value="${escapeHtml(r.observations || "")}"></label>
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
    return `<form id="edit-form" class="remuneration-form" data-table="remuneration_gerant" data-action="saveRemuneration">
      <input type="hidden" name="id" value="${escapeHtml(r.id || "")}">
      <input type="hidden" name="bareme_km" value="${escapeHtml(r.bareme_km || 0.636)}">
      <div class="detail-month-head">
        <label>Mois<input type="month" name="mois" value="${escapeHtml(String(r.mois || monthDate(state.month)).slice(0, 7))}" required></label>
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
          <div><small>Brute 7%</small><strong data-recap="brute">0.00 EUR</strong></div>
          <div><small>Nette apres abattement</small><strong data-recap="nette">0.00 EUR</strong></div>
          <div><small>Heures</small><strong data-recap="heures">0.00</strong></div>
          <div><small>Frais km</small><strong data-recap="frais_km">0.00 EUR</strong></div>
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
        result[field.dataset.field] = field.type === "number" ? numberValue(field.value) : String(field.value || "").trim();
      });
      return result;
    }).filter((row) => Object.values(row).some((value) => typeof value === "number" ? value !== 0 : value !== ""));
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
    const km = round2(interventions.reduce((total, line) => total + numberValue(line.km), 0));
    const autresFrais = round2(interventions.reduce((total, line) => total + numberValue(line.autres_frais), 0));
    const primeEdl = round2(primes.reduce((total, line) => total + numberValue(line.prime), 0));
    const primeResponsabilite = numberValue(form.elements.prime_responsabilite.value);
    const baremeKm = Number(form.elements.bareme_km.value) || 0.636;
    const brute = round2(encaissementsHt * 0.07);
    const nette = round2(brute * 0.70);
    const fraisKm = round2(km * baremeKm);
    const total = round2(
      encaissementsHt * 0.07 * 0.70 +
      km * baremeKm +
      primeEdl +
      primeResponsabilite +
      (form.elements.autres_frais_inclus_total.checked ? autresFrais : 0)
    );
    return { encaissements, interventions, primes, encaissementsHt, heures, km, autresFrais, primeEdl, primeResponsabilite, baremeKm, brute, nette, fraisKm, total };
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
    go(route) { state.route = route; render(); },
    setMonth(v) { state.month = v || currentMonth(); render(); },
    setYear(v) { state.year = String(v || new Date().getFullYear()); render(); },
    generateRents,
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
      const totals = remunerationDetailTotals(form, true);
      const values = {
        encaissements: euro(totals.encaissementsHt),
        brute: euro(totals.brute),
        nette: euro(totals.nette),
        heures: totals.heures.toFixed(2),
        frais_km: euro(totals.fraisKm),
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
      await dbDelete(table, id);
      await refresh("Ligne supprimee");
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
      const r = state.data.baux.find((x) => x.id === id) || { statut: "Actif", type_bail: "Commercial", tva: 0 };
      openModal("Bail", formHtml([
        { type: "hidden", name: "id", value: r.id || "" },
        { type: "select", name: "local_id", label: "Local", value: r.local_id, options: options("locaux", "Choisir") },
        { type: "select", name: "locataire_id", label: "Locataire et telephone", value: r.locataire_id, options: bailTenantOptions("Choisir") },
        { name: "type_bail", label: "Type bail", value: r.type_bail || "" },
        { type: "date", name: "date_debut", label: "Debut", value: r.date_debut || "" },
        { type: "date", name: "date_fin", label: "Fin", value: r.date_fin || "" },
        { type: "number", step: "0.01", name: "loyer_ht", label: "Loyer HT", value: r.loyer_ht || 0 },
        { type: "number", step: "0.01", name: "tva", label: "TVA %", value: r.tva || 0 },
        { type: "number", step: "0.01", name: "charges_mensuelles", label: "Charges", value: r.charges_mensuelles || 0 },
        { type: "number", step: "0.01", min: "0", name: "depot_garantie", label: "Depot de garantie", value: r.depot_garantie || 0 },
        { type: "checkbox", name: "renouvellement_auto", label: "Renouvellement automatique", value: r.renouvellement_auto },
        { type: "select", name: "statut", label: "Statut", value: r.statut, options: ["Actif", "En preparation", "Renouvele", "Resilie", "Archive"].map((x) => ({ value: x, label: x })) },
        { name: "document_url", label: "Lien du bail", value: r.document_url || "" },
        { type: "textarea", name: "observations", label: "Observations", value: r.observations || "" }
      ], "baux"));
    },
    openTravaux(id) {
      if (!ensureAdminAction()) return;
      const r = state.data.travaux.find((x) => x.id === id) || { statut: "A faire", priorite: "Normale" };
      openModal("Travaux", formHtml([
        { type: "hidden", name: "id", value: r.id || "" },
        { name: "titre", label: "Titre", value: r.titre || "" },
        { type: "select", name: "local_id", label: "Local", value: r.local_id, options: options("locaux", "General") },
        { type: "select", name: "priorite", label: "Priorite", value: r.priorite, options: ["Faible", "Normale", "Urgente", "Critique"].map((x) => ({ value: x, label: x })) },
        { type: "select", name: "statut", label: "Statut", value: r.statut, options: ["A faire", "Devis", "Programme", "En cours", "Realise", "Paye"].map((x) => ({ value: x, label: x })) },
        { type: "textarea", name: "description", label: "Description", value: r.description || "" }
      ], "travaux"));
    },
    openRemuneration(id) {
      if (!ensureAdminAction()) return;
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
      const base = readForm(form);
      const totals = remunerationDetailTotals(form, true);
      const mois = monthDate(String(base.mois || "").slice(0, 7));
      const existing = state.data.remuneration_gerant.find((row) => row.mois === mois && row.id !== base.id);
      const notes = String(base.detail_notes || "").trim();
      const details = {
        version: 1,
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

/* Controle Financeiro - painel (PWA). Dados no Supabase, tempo real entre aparelhos. */
(() => {
"use strict";

const { SUPABASE_URL, SUPABASE_KEY } = window.CF_CONFIG;
const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true },
});

/* ---------- utilitarios ---------- */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const pad = (n) => String(n).padStart(2, "0");
const iso = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;
const parse = (s) => { const [y, m, d] = s.split("-").map(Number); return { y, m, d }; };
const todayISO = () => { const t = new Date(); return iso(t.getFullYear(), t.getMonth() + 1, t.getDate()); };
const dim = (y, m) => new Date(y, m, 0).getDate();
const addDays = (s, n) => { const { y, m, d } = parse(s); const t = new Date(y, m - 1, d + n); return iso(t.getFullYear(), t.getMonth() + 1, t.getDate()); };
const brl = (v) => (Number(v) || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const fmtDM = (s) => { const p = parse(s); return `${pad(p.d)}/${pad(p.m)}`; };
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const MESES = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];
const net = (l) => (l.tipo === "entrada" ? 1 : -1) * Number(l.valor);
const TIPO_NOME = { entrada: "Entrada", saida: "Saída", diaria: "Diária" };

const CATS = [
  ["Moradia", /alug|condom|iptu/],
  ["Contas", /energ|luz|[aá]gua|internet|celular|telefone/],
  ["Saúde", /academ|farm|medic|dent|sa[uú]de/],
  ["Pessoal", /cabelo|barbe|roupa/],
  ["Alimentação", /mercad|padar|ifood|lanche|restaur|comida|aliment/],
  ["Transporte", /uber|gasol|combust|[oô]nibus|moto/],
  ["Empréstimos/Família", /empr[eé]st|\bpai\b|\bm[ãa]e\b|parcela/],
  ["Cartão", /cart[aã]o|nubank|picpay|bradesco/],
];
const catOf = (l) => {
  if (l.categoria) return l.categoria;
  const t = (l.descricao || "").toLowerCase();
  for (const [n, r] of CATS) if (r.test(t)) return n;
  return l.tipo === "diaria" ? "Diárias" : "Sem categoria";
};

/* ---------- estado ---------- */
const state = {
  lanc: [], fixas: [], cartoes: [],
  cfg: { saldo_inicial: 0, limite_vermelho: 200, limite_amarelo: 600 },
  tab: "hoje", mes: null, todos: false, user: null,
};
const faixa = (s) => (s < state.cfg.limite_vermelho ? "vermelho" : s <= state.cfg.limite_amarelo ? "amarelo" : "verde");

/* ---------- ui basica ---------- */
function toast(msg, ms = 2600) {
  const t = $("#toast"); t.textContent = msg; t.classList.remove("hidden");
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.add("hidden"), ms);
}
function setSync(s) { const d = $("#sync"); d.className = "dot " + (s === "ok" ? "" : s); d.title = { ok: "Sincronizado", busy: "Sincronizando...", off: "Sem conexão" }[s]; }
function openModal(html) { $("#sheet").innerHTML = html; $("#modal").classList.remove("hidden"); }
function closeModal() { $("#modal").classList.add("hidden"); $("#sheet").innerHTML = ""; }
$("#modal").addEventListener("click", (e) => { if (e.target.id === "modal") closeModal(); });

/* ---------- dados ---------- */
async function fetchAll(table, order) {
  let out = [], from = 0;
  for (;;) {
    const { data, error } = await sb.from(table).select("*").order(order, { ascending: true }).range(from, from + 999);
    if (error) throw error;
    out = out.concat(data);
    if (data.length < 1000) break;
    from += 1000;
  }
  return out;
}
async function loadAll() {
  setSync("busy");
  try {
    const [lanc, fixas, cartoes, cfgRes] = await Promise.all([
      fetchAll("lancamentos", "data"), fetchAll("contas_fixas", "dia"), fetchAll("cartoes", "ano"),
      sb.from("config").select("*").maybeSingle(),
    ]);
    state.lanc = lanc; state.fixas = fixas; state.cartoes = cartoes;
    if (cfgRes.error) throw cfgRes.error;
    if (cfgRes.data) state.cfg = { ...state.cfg, ...cfgRes.data, saldo_inicial: +cfgRes.data.saldo_inicial, limite_vermelho: +cfgRes.data.limite_vermelho, limite_amarelo: +cfgRes.data.limite_amarelo };
    else await sb.from("config").insert({});
    setSync("ok");
  } catch (e) {
    console.error(e); setSync("off"); toast("Não consegui carregar: " + (e.message || e));
  }
  render();
}

/* ---------- calculos ---------- */
function saldoAte(dia) {
  let s = state.cfg.saldo_inicial;
  for (const l of state.lanc) if (l.data <= dia) s += net(l);
  return s;
}
function serieMes(y, m) {
  const ini = iso(y, m, 1), n = dim(y, m);
  let s = state.cfg.saldo_inicial;
  for (const l of state.lanc) if (l.data < ini) s += net(l);
  const dias = [];
  for (let d = 1; d <= n; d++) {
    const k = iso(y, m, d);
    const it = state.lanc.filter((l) => l.data === k);
    const e = sum(it, "entrada"), sa = sum(it, "saida"), di = sum(it, "diaria");
    s += e - sa - di;
    dias.push({ d, k, e, sa, di, saldo: s, it });
  }
  return dias;
}
const sum = (arr, tipo) => arr.filter((l) => l.tipo === tipo).reduce((a, l) => a + Number(l.valor), 0);

function resumo() {
  const hoje = todayISO(), { y, m, d } = parse(hoje), n = dim(y, m);
  const serie = serieMes(y, m);
  const saldoHoje = serie[d - 1].saldo;
  const fim = serie[n - 1].saldo;
  const mesIt = state.lanc.filter((l) => l.data.startsWith(`${y}-${pad(m)}`));
  const ent = sum(mesIt, "entrada"), sai = sum(mesIt, "saida"), dia = sum(mesIt, "diaria");
  const eco = ent > 0 ? (ent - sai - dia) / ent : null;
  // proximos 7 dias
  const lim7 = addDays(hoje, 7);
  const prox = state.lanc.filter((l) => l.data > hoje && l.data <= lim7);
  const prox7s = prox.filter((l) => l.tipo !== "entrada"), prox7e = prox.filter((l) => l.tipo === "entrada");
  // menor saldo previsto daqui pra frente (no mes)
  let min = { v: Infinity, k: hoje };
  for (let i = d - 1; i < n; i++) if (serie[i].saldo < min.v) min = { v: serie[i].saldo, k: serie[i].k };
  // media de gasto diario (ultimos 14 dias, so 'diaria')
  const ini14 = addDays(hoje, -13);
  const g14 = state.lanc.filter((l) => l.tipo === "diaria" && l.data >= ini14 && l.data <= hoje).reduce((a, l) => a + Number(l.valor), 0);
  const restantes = n - d + 1;
  const podeDia = (fim - state.cfg.limite_vermelho) / restantes;
  const cartMes = state.cartoes.filter((c) => c.ano === y && c.mes === m).reduce((a, c) => a + Number(c.valor), 0);
  return { hoje, y, m, d, n, serie, saldoHoje, fim, ent, sai, dia, eco, prox7s, prox7e, min, g14, restantes, podeDia, cartMes };
}

function textoBomDia(r) {
  const sem = new Date(r.y, r.m - 1, r.d).toLocaleDateString("pt-BR", { weekday: "long" });
  const L = [];
  const h = new Date().getHours();
  L.push(`${h < 12 ? "Bom dia" : h < 18 ? "Boa tarde" : "Boa noite"}! Hoje é ${sem}, ${pad(r.d)}/${pad(r.m)}.`);
  L.push(`Saldo agora: ${brl(r.saldoHoje)} (faixa ${faixa(r.saldoHoje)}).`);
  L.push(`No mês: entrou ${brl(r.ent)}, saiu ${brl(r.sai)} em contas e ${brl(r.dia)} em diárias` + (r.eco !== null ? `. Economia: ${(r.eco * 100).toFixed(0)}%.` : "."));
  if (r.prox7s.length || r.prox7e.length) {
    const s = r.prox7s.reduce((a, l) => a + Number(l.valor), 0), e = r.prox7e.reduce((a, l) => a + Number(l.valor), 0);
    L.push(`Próximos 7 dias: ${r.prox7s.length ? `saem ${brl(s)} (${r.prox7s.length} lançamentos)` : "nenhuma saída"}${r.prox7e.length ? `, entram ${brl(e)}` : ""}.`);
  } else L.push("Próximos 7 dias: nada previsto.");
  L.push(`Projeção até o fim do mês: ${brl(r.fim)}. Menor saldo previsto: ${brl(r.min.v)} em ${fmtDM(r.min.k)}.`);
  if (r.podeDia > 0) L.push(`Dá para gastar cerca de ${brl(r.podeDia)} por dia até o fim do mês sem cair abaixo de ${brl(state.cfg.limite_vermelho)}.`);
  else L.push(`Atenção: pelo previsto, não sobra margem para gastos diários sem passar de ${brl(state.cfg.limite_vermelho)}.`);
  if (r.g14 > 0) L.push(`Você gastou ${brl(r.g14 / 14)} por dia nas diárias dos últimos 14 dias.`);
  if (r.cartMes > 0) L.push(`Cartões neste mês: ${brl(r.cartMes)}.`);
  return L.join("\n");
}

/* ---------- telas ---------- */
function render() {
  if (!state.user) return;
  $("#hdrSub").textContent = state.user.email || "";
  if (state.tab === "hoje") renderHoje();
  if (state.tab === "mes") renderMes();
  if (state.tab === "lancar") renderLancar();
  if (state.tab === "contas") renderContas();
  if (state.tab === "config") renderConfig();
}

function chartSvg(serie, hojeD) {
  const W = 340, H = 120, P = 6;
  const vals = serie.map((x) => x.saldo);
  const lo = Math.min(...vals, state.cfg.limite_vermelho), hi = Math.max(...vals, state.cfg.limite_amarelo);
  const sx = (i) => P + (i * (W - 2 * P)) / Math.max(serie.length - 1, 1);
  const sy = (v) => H - P - ((v - lo) / Math.max(hi - lo, 1)) * (H - 2 * P);
  const pts = serie.map((x, i) => `${sx(i).toFixed(1)},${sy(x.saldo).toFixed(1)}`).join(" ");
  const line = (v, c) => `<line x1="${P}" x2="${W - P}" y1="${sy(v)}" y2="${sy(v)}" stroke="${c}" stroke-dasharray="3 4" opacity=".6"/>`;
  const hx = hojeD ? `<line x1="${sx(hojeD - 1)}" x2="${sx(hojeD - 1)}" y1="${P}" y2="${H - P}" stroke="#38bdf8" opacity=".7"/>` : "";
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">${line(state.cfg.limite_vermelho, "#ef4444")}${line(state.cfg.limite_amarelo, "#eab308")}${hx}<polyline fill="none" stroke="#22c55e" stroke-width="2.5" points="${pts}"/></svg>`;
}

function renderHoje() {
  const r = resumo(), f = faixa(r.saldoHoje);
  const alertas = [];
  if (r.min.v < state.cfg.limite_vermelho) alertas.push(`<div class="alert"><b>Saldo baixo previsto:</b> ${brl(r.min.v)} em ${fmtDM(r.min.k)} (abaixo de ${brl(state.cfg.limite_vermelho)}).</div>`);
  else if (r.min.v <= state.cfg.limite_amarelo) alertas.push(`<div class="alert w"><b>Atenção:</b> o saldo chega a ${brl(r.min.v)} em ${fmtDM(r.min.k)}.</div>`);
  else alertas.push(`<div class="alert ok">Mês tranquilo: o menor saldo previsto é ${brl(r.min.v)}.</div>`);

  const prox = state.lanc.filter((l) => l.data >= r.hoje && l.data <= addDays(r.hoje, 10) && l.tipo !== "entrada").slice(0, 8);
  $("#tab-hoje").innerHTML = `
    <div class="card hero">
      <div class="muted small">Saldo de hoje</div>
      <div class="big">${brl(r.saldoHoje)}</div>
      <div><span class="pill ${f}">${f}</span> <span class="muted small">projeção fim do mês: <b class="${r.fim < 0 ? "neg" : ""}">${brl(r.fim)}</b></span></div>
    </div>
    ${alertas.join("")}
    <div class="card"><h2>☀️ Resumo do dia</h2><p class="brief">${esc(textoBomDia(r))}</p></div>
    <div class="grid2">
      <div class="stat"><div class="l">Entradas do mês</div><div class="v pos">${brl(r.ent)}</div></div>
      <div class="stat"><div class="l">Saídas do mês</div><div class="v neg">${brl(r.sai)}</div></div>
      <div class="stat"><div class="l">Diárias do mês</div><div class="v warn">${brl(r.dia)}</div></div>
      <div class="stat"><div class="l">Pode gastar/dia</div><div class="v ${r.podeDia > 0 ? "pos" : "neg"}">${brl(Math.max(r.podeDia, 0))}</div></div>
    </div>
    <div class="card"><h2>Saldo do mês</h2>${chartSvg(r.serie, r.d)}</div>
    <div class="card"><h2>Próximas saídas (10 dias)</h2>
      ${prox.length ? prox.map((l) => `<div class="row"><div class="main"><div>${esc(l.descricao || catOf(l))}</div><div class="d">${fmtDM(l.data)} · ${esc(catOf(l))}</div></div><div class="val neg">${brl(l.valor)}</div></div>`).join("") : '<p class="muted">Nada previsto.</p>'}
    </div>`;
}

function renderMes() {
  if (!state.mes) { const { y, m } = parse(todayISO()); state.mes = { y, m }; }
  const { y, m } = state.mes, serie = serieMes(y, m), hoje = todayISO();
  const hojeP = parse(hoje), ehMesAtual = hojeP.y === y && hojeP.m === m;
  const it = state.lanc.filter((l) => l.data.startsWith(`${y}-${pad(m)}`));
  const ent = sum(it, "entrada"), sai = sum(it, "saida"), dia = sum(it, "diaria");
  const linhas = serie.filter((x) => state.todos || x.it.length || (ehMesAtual && x.d === hojeP.d));
  // categorias
  const cats = {};
  it.filter((l) => l.tipo !== "entrada").forEach((l) => { const c = catOf(l); cats[c] = (cats[c] || 0) + Number(l.valor); });
  const lista = Object.entries(cats).sort((a, b) => b[1] - a[1]), tot = lista.reduce((a, [, v]) => a + v, 0) || 1;

  $("#tab-mes").innerHTML = `
    <div class="monthbar"><button id="mPrev">‹</button><b>${MESES[m - 1]} ${y}</b><button id="mNext">›</button></div>
    <div class="grid2">
      <div class="stat"><div class="l">Entradas</div><div class="v pos">${brl(ent)}</div></div>
      <div class="stat"><div class="l">Saídas + diárias</div><div class="v neg">${brl(sai + dia)}</div></div>
      <div class="stat"><div class="l">Economia</div><div class="v">${ent > 0 ? (((ent - sai - dia) / ent) * 100).toFixed(0) + "%" : "—"}</div></div>
      <div class="stat"><div class="l">Saldo no fim</div><div class="v">${brl(serie[serie.length - 1].saldo)}</div></div>
    </div>
    <div class="card"><h2>Evolução do saldo</h2>${chartSvg(serie, ehMesAtual ? hojeP.d : 0)}</div>
    <div class="card">
      <div class="monthbar"><h2>Dia a dia</h2><button id="toggleDias" class="link small">${state.todos ? "só com movimento" : "mostrar todos os dias"}</button></div>
      <table><thead><tr><th>Dia</th><th>Entrada</th><th>Saída</th><th>Diária</th><th>Saldo</th></tr></thead><tbody>
      ${linhas.map((x) => `<tr class="click ${x.k === hoje ? "today" : ""} ${x.k > hoje ? "fut" : ""}" data-dia="${x.k}">
        <td>${x.d}</td><td class="pos">${x.e ? brl(x.e) : ""}</td><td class="neg">${x.sa ? brl(x.sa) : ""}</td><td class="warn">${x.di ? brl(x.di) : ""}</td>
        <td class="s ${faixa(x.saldo)}">${brl(x.saldo)}</td></tr>`).join("") || '<tr><td colspan="5" class="muted">Sem lançamentos.</td></tr>'}
      </tbody></table>
    </div>
    <div class="card"><h2>Gastos por categoria</h2>
      ${lista.length ? lista.map(([c, v]) => `<div style="margin-top:8px"><div class="row" style="border:0;padding:0"><span>${esc(c)}</span><span class="val">${brl(v)}</span></div><div class="bar"><i style="width:${((v / tot) * 100).toFixed(1)}%"></i></div></div>`).join("") : '<p class="muted">Nada neste mês.</p>'}
    </div>`;
  $("#mPrev").onclick = () => { state.mes = m === 1 ? { y: y - 1, m: 12 } : { y, m: m - 1 }; renderMes(); };
  $("#mNext").onclick = () => { state.mes = m === 12 ? { y: y + 1, m: 1 } : { y, m: m + 1 }; renderMes(); };
  $("#toggleDias").onclick = () => { state.todos = !state.todos; renderMes(); };
  $$("#tab-mes tr.click").forEach((tr) => (tr.onclick = () => abrirDia(tr.dataset.dia)));
}

function abrirDia(k) {
  const it = state.lanc.filter((l) => l.data === k);
  openModal(`<h2>${fmtDM(k)}/${parse(k).y}</h2>
    ${it.length ? it.map((l) => `<div class="row" data-id="${l.id}" style="cursor:pointer"><div class="main"><div>${esc(l.descricao || catOf(l))}</div><div class="d">${TIPO_NOME[l.tipo]} · ${esc(catOf(l))}${l.origem === "excel" ? " · Excel" : ""}</div></div><div class="val ${l.tipo === "entrada" ? "pos" : "neg"}">${brl(l.valor)}</div></div>`).join("") : '<p class="muted">Sem lançamentos neste dia.</p>'}
    <div class="actions"><button id="addDia" class="primary">Adicionar neste dia</button><button id="fechar">Fechar</button></div>`);
  $$("#sheet .row[data-id]").forEach((r) => (r.onclick = () => formLanc(state.lanc.find((l) => l.id === r.dataset.id))));
  $("#addDia").onclick = () => formLanc({ data: k, tipo: "saida" });
  $("#fechar").onclick = closeModal;
}

function formLanc(l, inline) {
  const novo = !l.id;
  const cats = [...new Set(state.lanc.map(catOf))].sort();
  const html = `
    ${inline ? "" : `<h2>${novo ? "Novo lançamento" : "Editar lançamento"}</h2>`}
    <div class="seg" id="seg">${["entrada", "saida", "diaria"].map((t) => `<button type="button" data-t="${t}" class="${t} ${l.tipo === t ? "on" : ""}">${TIPO_NOME[t]}</button>`).join("")}</div>
    <label>Valor <input id="fValor" inputmode="decimal" placeholder="0,00" value="${l.valor != null ? String(l.valor).replace(".", ",") : ""}"></label>
    <label>Data <input id="fData" type="date" value="${l.data || todayISO()}"></label>
    <label>Descrição <input id="fDesc" value="${esc(l.descricao || "")}" placeholder="ex.: mercado, salário..."></label>
    <label>Categoria <input id="fCat" list="cats" value="${esc(l.categoria || "")}" placeholder="automática se vazio"><datalist id="cats">${cats.map((c) => `<option value="${esc(c)}">`).join("")}</datalist></label>
    <div class="actions"><button id="fSalvar" class="primary">Salvar</button>${novo ? "" : '<button id="fExcluir" class="danger">Excluir</button>'}${inline ? "" : '<button id="fFechar">Cancelar</button>'}</div>`;
  const alvo = inline || $("#sheet");
  if (inline) inline.innerHTML = html; else openModal(html);
  let tipo = l.tipo || "saida";
  $$("#seg button", alvo).forEach((b) => (b.onclick = () => { tipo = b.dataset.t; $$("#seg button", alvo).forEach((x) => x.classList.toggle("on", x === b)); }));
  if (!inline) $("#fFechar").onclick = closeModal;
  if (!novo) $("#fExcluir").onclick = async () => {
    if (!confirm("Excluir este lançamento?")) return;
    const { error } = await sb.from("lancamentos").delete().eq("id", l.id);
    if (error) return toast("Erro: " + error.message);
    state.lanc = state.lanc.filter((x) => x.id !== l.id); closeModal(); toast("Excluído"); render();
  };
  $("#fSalvar").onclick = async () => {
    const valor = parseFloat(String($("#fValor").value).replace(/\./g, "").replace(",", "."));
    if (!(valor >= 0) || Number.isNaN(valor)) return toast("Informe um valor válido");
    const rec = { tipo, valor, data: $("#fData").value, descricao: $("#fDesc").value.trim() || null, categoria: $("#fCat").value.trim() || null };
    if (!rec.data) return toast("Informe a data");
    setSync("busy");
    const q = novo ? sb.from("lancamentos").insert({ ...rec, origem: "app" }).select().single()
                   : sb.from("lancamentos").update(rec).eq("id", l.id).select().single();
    const { data, error } = await q;
    if (error) { setSync("off"); return toast("Erro: " + error.message); }
    state.lanc = state.lanc.filter((x) => x.id !== data.id).concat(data).sort((a, b) => (a.data < b.data ? -1 : a.data > b.data ? 1 : 0));
    setSync("ok"); toast("Salvo ✓");
    if (inline) { state.tab = "hoje"; showTab(); } else closeModal();
    render();
  };
}

function renderLancar() {
  $("#tab-lancar").innerHTML = `<div class="card" id="boxLanc"></div>`;
  formLanc({ tipo: "saida", data: todayISO() }, $("#boxLanc"));
}

function renderContas() {
  const { y, m } = parse(todayISO());
  const doAno = state.cartoes.filter((c) => c.ano === y);
  const porMes = {}; doAno.forEach((c) => (porMes[c.mes] = (porMes[c.mes] || 0) + Number(c.valor)));
  $("#tab-contas").innerHTML = `
    <div class="card"><div class="monthbar"><h2>Contas fixas</h2><button id="novaFixa" class="link">+ nova</button></div>
      ${state.fixas.map((f) => `<div class="row" data-id="${f.id}" style="cursor:pointer"><div class="main"><div>${esc(f.nome)} ${f.ativa ? "" : '<span class="muted">(pausada)</span>'}</div><div class="d">todo dia ${f.dia}</div></div><div class="val">${brl(f.valor)}</div></div>`).join("") || '<p class="muted">Nenhuma conta fixa.</p>'}
      <p class="muted small">Total mensal ativo: <b>${brl(state.fixas.filter((f) => f.ativa).reduce((a, f) => a + Number(f.valor), 0))}</b></p>
      <button id="gerarFixas" class="primary">Gerar contas fixas de ${MESES[m - 1]}</button>
      <p class="muted small">Só cria as que ainda não foram lançadas neste mês.</p>
    </div>
    <div class="card"><div class="monthbar"><h2>Cartões de crédito ${y}</h2><button id="novoCartao" class="link">+ fatura</button></div>
      ${MESES.map((nm, i) => porMes[i + 1] ? `<div class="row"><span style="text-transform:capitalize">${nm}</span><span class="val">${brl(porMes[i + 1])}</span></div>` : "").join("") || '<p class="muted">Sem faturas lançadas.</p>'}
    </div>`;
  $("#novaFixa").onclick = () => formFixa({});
  $$("#tab-contas .row[data-id]").forEach((r) => (r.onclick = () => formFixa(state.fixas.find((f) => f.id === r.dataset.id))));
  $("#gerarFixas").onclick = gerarFixas;
  $("#novoCartao").onclick = formCartao;
}

function formFixa(f) {
  const novo = !f.id;
  openModal(`<h2>${novo ? "Nova conta fixa" : "Editar conta fixa"}</h2>
    <label>Nome <input id="cNome" value="${esc(f.nome || "")}"></label>
    <label>Valor <input id="cValor" inputmode="decimal" value="${f.valor != null ? String(f.valor).replace(".", ",") : ""}"></label>
    <label>Dia do mês <input id="cDia" type="number" min="1" max="31" value="${f.dia || 1}"></label>
    <label><span><input type="checkbox" id="cAtiva" ${f.ativa !== false ? "checked" : ""} style="width:auto"> Ativa</span></label>
    <div class="actions"><button id="cSalvar" class="primary">Salvar</button>${novo ? "" : '<button id="cExcluir" class="danger">Excluir</button>'}<button id="cFechar">Cancelar</button></div>`);
  $("#cFechar").onclick = closeModal;
  if (!novo) $("#cExcluir").onclick = async () => {
    if (!confirm("Excluir esta conta fixa? Os lançamentos já criados continuam.")) return;
    const { error } = await sb.from("contas_fixas").delete().eq("id", f.id);
    if (error) return toast("Erro: " + error.message);
    state.fixas = state.fixas.filter((x) => x.id !== f.id); closeModal(); render();
  };
  $("#cSalvar").onclick = async () => {
    const rec = { nome: $("#cNome").value.trim(), valor: parseFloat(String($("#cValor").value).replace(/\./g, "").replace(",", ".")), dia: +$("#cDia").value, ativa: $("#cAtiva").checked };
    if (!rec.nome || !(rec.valor >= 0) || !(rec.dia >= 1 && rec.dia <= 31)) return toast("Confira nome, valor e dia");
    const q = novo ? sb.from("contas_fixas").insert(rec).select().single() : sb.from("contas_fixas").update(rec).eq("id", f.id).select().single();
    const { data, error } = await q;
    if (error) return toast("Erro: " + error.message);
    state.fixas = state.fixas.filter((x) => x.id !== data.id).concat(data).sort((a, b) => a.dia - b.dia);
    closeModal(); toast("Salvo ✓"); render();
  };
}

async function gerarFixas() {
  const { y, m } = parse(todayISO()), pre = `${y}-${pad(m)}`;
  const jaTem = new Set(state.lanc.filter((l) => l.conta_fixa_id && l.data.startsWith(pre)).map((l) => l.conta_fixa_id));
  const novos = state.fixas.filter((f) => f.ativa && !jaTem.has(f.id)).map((f) => ({
    data: iso(y, m, Math.min(f.dia, dim(y, m))), tipo: "saida", valor: f.valor, descricao: f.nome, conta_fixa_id: f.id, origem: "app",
  }));
  if (!novos.length) return toast("Todas as contas fixas já foram lançadas.");
  if (!confirm(`Criar ${novos.length} saídas de ${MESES[m - 1]} (${brl(novos.reduce((a, x) => a + Number(x.valor), 0))})?\nSe você já lançou essas contas na planilha, elas podem duplicar.`)) return;
  const { data, error } = await sb.from("lancamentos").insert(novos).select();
  if (error) return toast("Erro: " + error.message);
  state.lanc = state.lanc.concat(data).sort((a, b) => (a.data < b.data ? -1 : 1));
  toast(`${data.length} contas lançadas ✓`); render();
}

function formCartao() {
  const { y, m } = parse(todayISO());
  openModal(`<h2>Fatura de cartão</h2>
    <label>Cartão <input id="kNome" list="kc" placeholder="Nubank, PicPay..."><datalist id="kc">${[...new Set(state.cartoes.map((c) => c.cartao))].map((c) => `<option value="${esc(c)}">`).join("")}</datalist></label>
    <label>Mês <select id="kMes">${MESES.map((n, i) => `<option value="${i + 1}" ${i + 1 === m ? "selected" : ""}>${n}</option>`).join("")}</select></label>
    <label>Ano <input id="kAno" type="number" value="${y}"></label>
    <label>Valor da fatura <input id="kValor" inputmode="decimal"></label>
    <div class="actions"><button id="kSalvar" class="primary">Salvar</button><button id="kFechar">Cancelar</button></div>`);
  $("#kFechar").onclick = closeModal;
  $("#kSalvar").onclick = async () => {
    const rec = { cartao: $("#kNome").value.trim(), mes: +$("#kMes").value, ano: +$("#kAno").value, valor: parseFloat(String($("#kValor").value).replace(/\./g, "").replace(",", ".")) };
    if (!rec.cartao || !(rec.valor >= 0)) return toast("Confira cartão e valor");
    const { data, error } = await sb.from("cartoes").upsert(rec, { onConflict: "user_id,ano,mes,cartao" }).select().single();
    if (error) return toast("Erro: " + error.message);
    state.cartoes = state.cartoes.filter((c) => c.id !== data.id).concat(data);
    closeModal(); toast("Salvo ✓"); render();
  };
}

function renderConfig() {
  const c = state.cfg;
  $("#tab-config").innerHTML = `
    <div class="card"><h2>Faixas de saldo</h2>
      <p class="muted small">Igual às cores da planilha: abaixo do vermelho = vermelho; até o amarelo = amarelo; acima = verde.</p>
      <label>Vermelho abaixo de (R$) <input id="cV" inputmode="decimal" value="${String(c.limite_vermelho).replace(".", ",")}"></label>
      <label>Verde acima de (R$) <input id="cA" inputmode="decimal" value="${String(c.limite_amarelo).replace(".", ",")}"></label>
      <label>Saldo inicial (antes do 1º lançamento) <input id="cS" inputmode="decimal" value="${String(c.saldo_inicial).replace(".", ",")}"></label>
      <button id="salvarCfg" class="primary">Salvar</button>
    </div>
    <div class="card"><h2>Dados</h2>
      <p class="muted small">${state.lanc.length} lançamentos · conectado como ${esc(state.user.email)}</p>
      <div class="actions"><button id="recarregar">Atualizar agora</button><button id="sair2" class="danger">Sair</button></div>
    </div>
    <div class="card"><h2>Excel</h2>
      <p class="muted small">Importar da planilha e exportar uma cópia atualizada é feito no computador pelos scripts da pasta <b>tools</b>. O arquivo original nunca é sobrescrito.</p>
    </div>`;
  $("#salvarCfg").onclick = async () => {
    const num = (id) => parseFloat(String($(id).value).replace(/\./g, "").replace(",", "."));
    const rec = { limite_vermelho: num("#cV"), limite_amarelo: num("#cA"), saldo_inicial: num("#cS"), updated_at: new Date().toISOString() };
    if (Object.values(rec).some((v) => typeof v === "number" && Number.isNaN(v))) return toast("Confira os números");
    const { error } = await sb.from("config").upsert({ ...rec, user_id: state.user.id });
    if (error) return toast("Erro: " + error.message);
    Object.assign(state.cfg, rec); toast("Salvo ✓"); render();
  };
  $("#recarregar").onclick = loadAll;
  $("#sair2").onclick = sair;
}

/* ---------- navegacao ---------- */
const TITULOS = { hoje: "Hoje", mes: "Mês", lancar: "Novo lançamento", contas: "Contas e cartões", config: "Mais" };
function showTab() {
  ["hoje", "mes", "lancar", "contas", "config"].forEach((t) => $("#tab-" + t).classList.toggle("hidden", t !== state.tab));
  $$("nav button").forEach((b) => b.classList.toggle("active", b.dataset.tab === state.tab));
  $("#hdrTitle").textContent = TITULOS[state.tab];
  window.scrollTo(0, 0); render();
}
$$("nav button").forEach((b) => (b.onclick = () => { state.tab = b.dataset.tab; showTab(); }));

/* ---------- autenticacao ---------- */
function mostrarLogin() { $("#app").classList.add("hidden"); $("#login").classList.remove("hidden"); }
async function mostrarApp(user) {
  state.user = user; $("#login").classList.add("hidden"); $("#app").classList.remove("hidden");
  showTab(); await loadAll(); assinarTempoReal();
}
async function sair() { await sb.auth.signOut(); state.user = null; state.lanc = []; mostrarLogin(); }
$("#btnSair").onclick = sair;

$("#loginForm").onsubmit = async (e) => {
  e.preventDefault();
  const msg = $("#loginMsg"); msg.textContent = "Entrando...";
  const { data, error } = await sb.auth.signInWithPassword({ email: $("#email").value.trim(), password: $("#senha").value });
  if (error) { msg.textContent = error.message === "Invalid login credentials" ? "E-mail ou senha incorretos." : error.message; return; }
  msg.textContent = ""; mostrarApp(data.user);
};
$("#btnCriar").onclick = async () => {
  const msg = $("#loginMsg");
  const email = $("#email").value.trim(), password = $("#senha").value;
  if (!email || password.length < 8) { msg.textContent = "Informe e-mail e uma senha de pelo menos 8 caracteres."; return; }
  msg.textContent = "Criando conta...";
  const { data, error } = await sb.auth.signUp({ email, password });
  if (error) { msg.textContent = error.message; return; }
  if (data.session) mostrarApp(data.user);
  else msg.textContent = "Conta criada. Confirme pelo link enviado ao seu e-mail e depois entre.";
};

/* ---------- tempo real (PC <-> celular) ---------- */
let canal = null, tRecarrega = null;
function assinarTempoReal() {
  if (canal) return;
  const agenda = () => { clearTimeout(tRecarrega); tRecarrega = setTimeout(loadAll, 600); };
  canal = sb.channel("cf-sync")
    .on("postgres_changes", { event: "*", schema: "public", table: "lancamentos" }, agenda)
    .on("postgres_changes", { event: "*", schema: "public", table: "contas_fixas" }, agenda)
    .subscribe((s) => { if (s === "SUBSCRIBED") setSync("ok"); });
}
document.addEventListener("visibilitychange", () => { if (!document.hidden && state.user) loadAll(); });

/* ---------- inicio ---------- */
(async () => {
  if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost")) navigator.serviceWorker.register("sw.js").catch(() => {});
  const { data } = await sb.auth.getSession();
  if (data.session) mostrarApp(data.session.user); else mostrarLogin();
})();
})();

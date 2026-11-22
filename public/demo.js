function updatePermUI() {
  const badge = document.getElementById("perm-badge");
  const help = document.getElementById("perm-help");
  const perm = ("Notification" in window) ? Notification.permission : "unsupported";

  if (perm === "granted") {
    badge.textContent = "Concedida (Permitido)";
    badge.className = "badge granted";
    if (help) help.style.display = "none";
  } else if (perm === "denied") {
    badge.textContent = "Bloqueada (Negada)";
    badge.className = "badge denied";
    if (help) {
      help.style.display = "block";
      help.innerHTML = "<strong>Como desbloquear:</strong><br>1. Clique no ícone de controles deslizantes (ou cadeado) na barra de endereços do Chrome, à esquerda de <code>localhost:3000</code>.<br>2. Altere <strong>Notificações</strong> para <strong>Permitir</strong>.<br>3. Recarregue esta página (Cmd + R).";
    }
  } else {
    badge.textContent = "Padrão (Não solicitada)";
    badge.className = "badge default";
    if (help) help.style.display = "none";
  }
}

if (location.protocol === "file:") {
  const st = document.getElementById("st");
  if (st) {
    st.innerHTML = "<span style='color:#c00;font-weight:600'>Aviso:</span> Esta página foi aberta diretamente pelo arquivo (<code>file://</code>). O Service Worker e as notificações push requerem que o servidor esteja rodando (<code>npm start</code>) e a página seja acessada via <a href='http://localhost:3000/demo.html'>http://localhost:3000/demo.html?site=SEU_CODIGO</a>.";
  }
}

updatePermUI();

document.getElementById("b").onclick = async () => {
  const st = document.getElementById("st");
  try {
    st.textContent = "Solicitando permissão e inscrevendo...";
    await PushPainel.ativar({ site: new URLSearchParams(location.search).get("site") || "" });
    updatePermUI();
    st.innerHTML = "<span style='color:#16a34a;font-weight:600'>✔ Inscrição concluída com sucesso!</span><br>Seu navegador está registrado. Você já pode enviar pelo painel.";
  } catch (e) {
    updatePermUI();
    st.innerHTML = "<span style='color:#dc2626;font-weight:600'>Erro:</span> " + e.message;
  }
};

document.getElementById("b-local").onclick = async () => {
  const st = document.getElementById("st");
  if (!("Notification" in window)) {
    st.textContent = "Este navegador não suporta a API Notification.";
    return;
  }
  if (Notification.permission !== "granted") {
    const p = await Notification.requestPermission();
    updatePermUI();
    if (p !== "granted") {
      st.innerHTML = "<span style='color:#dc2626;font-weight:600'>Permissão não concedida.</span> Desbloqueie as notificações no Chrome.";
      return;
    }
  }
  try {
    const n = new Notification("Teste Local Antigravity", {
      body: "Se você está lendo isso, seu Mac e o Chrome exibem notificações normalmente!",
      icon: "/uploads/3942e4a3aaec457d.png"
    });
    n.onclick = () => window.focus();
    st.innerHTML = "<span style='color:#16a34a;font-weight:600'>Notificação disparada no sistema!</span> Se não saltou na tela, confira a Central de Notificações no topo direito do Mac.";
  } catch (err) {
    st.innerHTML = "<span style='color:#dc2626;font-weight:600'>Falha ao exibir:</span> " + err.message;
  }
};

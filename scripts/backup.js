/* Backup consistente do banco (seguro mesmo com o servidor rodando). Uso: npm run backup */
const path = require("path"), fs = require("fs"), store = require("../lib/store");
const data = path.resolve(process.env.DATA_DIR || path.join(__dirname, "..", "data"));
const dir = path.join(data, "backups"); fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
store.open(data);
const file = path.join(dir, "push-" + new Date().toISOString().replace(/[:.]/g, "-") + ".db");
store.backup(file)
  .then(() => {
    console.log("Backup criado:", file);
    console.log("Guarde também as chaves VAPID (data/vapid.json ou as variáveis do .env).");
    return store.close();
  })
  .catch(e => {
    console.error("Erro no backup:", e.message);
    process.exit(1);
  });

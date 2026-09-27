// Key, token and password files: never collected from an agent's folder.
// Ported from the CanvasTTY chain (command review, isCredentialPath).
const CREDENTIAL_NAMES = new Set([".netrc", "_netrc", ".npmrc", ".pypirc", ".git-credentials", ".pgpass", ".htpasswd", "credentials",
  "credentials.json", ".credentials.json", "auth.json", "id_rsa", "id_dsa", "id_ecdsa", "id_ed25519", "id_ecdsa_sk", "id_ed25519_sk", ".env"]);
const CREDENTIAL_DIRS = ["/.ssh/", "/.gnupg/", "/.aws/", "/.azure/", "/.kube/", "/.docker/", "/library/keychains/", "/.config/gcloud/",
  "/.config/gh/", "/.password-store/", "/.local/share/keyrings/"];

export function isCredentialPath(path) {
  const lower = path.replace(/\\/gu, "/").toLowerCase();
  const name = lower.slice(lower.lastIndexOf("/") + 1);
  if (CREDENTIAL_NAMES.has(name)) return true;
  if (/^\.env\./u.test(name) && !/\.(example|sample|template|dist|defaults?)$/u.test(name)) return true;
  if (/\.(pem|key|p12|pfx|jks|keystore|kdbx|ppk)$/u.test(name)) return true;
  if (/^id_[a-z0-9_]+$/u.test(name)) return true;
  if (/(^|[._-])secrets?(\.|$)/u.test(name)) return true;
  return CREDENTIAL_DIRS.some((dir) => `/${lower}`.includes(dir));
}

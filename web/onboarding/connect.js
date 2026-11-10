/* global document, fetch, navigator, HTMLInputElement, HTMLButtonElement */
async function copyLink(button) {
  const action = button.getAttribute("data-copy");
  const nonceField = document.querySelector('input[name="nonce"]');
  const nonce = nonceField instanceof HTMLInputElement ? nonceField.value : "";
  try {
    if (!action) return;
    const response = await fetch(action, {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ nonce }),
    });
    if (!response.ok) return;
    const payload = await response.json();
    const url = payload && typeof payload.url === "string" ? payload.url : "";
    if (!url || !navigator.clipboard) return;
    await navigator.clipboard.writeText(url);
    const note = document.querySelector("#copy-note");
    if (note) note.removeAttribute("hidden");
  } finally {
    button.disabled = false;
  }
}

const copyButton = document.querySelector("#copy-link");
if (copyButton instanceof HTMLButtonElement) {
  copyButton.addEventListener("click", () => {
    if (copyButton.disabled) return;
    copyButton.disabled = true;
    copyLink(copyButton).catch(() => undefined);
  });
}

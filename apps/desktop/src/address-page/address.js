// The address page script. It talks to the main process only through window.capybaraAddress
// (the address preload): submit(address) runs normalization and discovery in main, open() saves
// what main discovered and loads the deployment.
(() => {
  const api = window.capybaraAddress;
  if (!api) return;
  const s = (key) => api.strings[key] ?? key;

  document.documentElement.lang = api.locale === "zh" ? "zh-CN" : "en";
  document.title = s("address.title");
  for (const el of document.querySelectorAll("[data-i18n]")) {
    el.textContent = s(el.getAttribute("data-i18n"));
  }

  const form = document.getElementById("address-form");
  const input = document.getElementById("address");
  const error = document.getElementById("error");
  const continueButton = document.getElementById("continue");
  const found = document.getElementById("found");
  const icon = document.getElementById("icon");
  const name = document.getElementById("name");
  const host = document.getElementById("host");
  const openButton = document.getElementById("open");
  const changeButton = document.getElementById("change");

  input.placeholder = s("address.placeholder");
  if (api.prefill) input.value = api.prefill;

  const showError = (kind) => {
    error.textContent = s(`address.error.${kind}`);
    error.hidden = false;
    input.setAttribute("aria-invalid", "true");
  };
  const clearError = () => {
    error.hidden = true;
    error.textContent = "";
    input.removeAttribute("aria-invalid");
  };
  const busy = (button, on, label) => {
    button.disabled = on;
    button.textContent = s(on ? "address.checking" : label);
  };

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    clearError();
    busy(continueButton, true, "address.continue");
    const result = await api.submit(input.value);
    busy(continueButton, false, "address.continue");
    if (!result.ok) {
      showError(result.error);
      input.focus();
      return;
    }
    name.textContent = result.name;
    host.textContent = result.host;
    if (result.icon?.startsWith("data:image/")) {
      icon.src = result.icon;
      icon.hidden = false;
    } else {
      icon.removeAttribute("src");
      icon.hidden = true;
    }
    form.hidden = true;
    found.hidden = false;
    openButton.focus();
  });

  changeButton.addEventListener("click", () => {
    found.hidden = true;
    form.hidden = false;
    input.focus();
    input.select();
  });

  openButton.addEventListener("click", async () => {
    busy(openButton, true, "address.open");
    const result = await api.open();
    if (!result.ok) {
      busy(openButton, false, "address.open");
      found.hidden = true;
      form.hidden = false;
      showError(result.error);
    }
  });

  input.focus();
})();

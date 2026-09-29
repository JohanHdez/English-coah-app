if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js');
}

const status = document.querySelector('#app p');
if (status) status.textContent = 'Listo.';

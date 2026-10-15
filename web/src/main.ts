import { createApp } from 'vue';
import { createPinia } from 'pinia';
import App from './App.vue';
import { router } from './router';
import './style.css';
import './design.css';

const app = createApp(App);
app.config.errorHandler = (error, _instance, info) => {
  console.error('[MainlineVue]', info, error);
  window.dispatchEvent(new CustomEvent('mainline:vue-error', {
    detail: `${info}: ${error instanceof Error ? error.stack ?? error.message : String(error)}`,
  }));
};
app.use(createPinia());
app.use(router);
app.mount('#app');

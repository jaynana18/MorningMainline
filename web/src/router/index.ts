import { createRouter, createWebHashHistory, type RouteRecordRaw } from 'vue-router';
import HomeView from '../views/HomeView.vue';
import QuickCreateView from '../views/QuickCreateView.vue';
import SessionView from '../views/SessionView.vue';

const routes: RouteRecordRaw[] = [
  { path: '/', name: 'home', component: HomeView },
  { path: '/create', name: 'create', component: QuickCreateView },
  { path: '/session', name: 'session', component: SessionView },
  { path: '/:pathMatch(.*)*', redirect: '/' },
];

/** 使用 hash 模式，避免静态托管需额外配置 history fallback。 */
export const router = createRouter({
  history: createWebHashHistory(),
  routes,
});

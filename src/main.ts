import './styles.css';
import { registry } from './drivers';
import { App } from './ui/app';

new App(document.getElementById('app')!, registry).start();

import './styles.css'

import { LeetcoderApp } from './app'

const root = document.querySelector<HTMLElement>('#app')
if (!root) {
  throw new Error('leetcoder root element was not found.')
}

const app = new LeetcoderApp(root)
void app.start()

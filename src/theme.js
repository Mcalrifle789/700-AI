// 700 AI theme — palette lifted from the brand image:
// deep black background, molten red/orange on the "700", fading to gold/green on "AI".
import chalk from 'chalk';
import gradient from 'gradient-string';

export const ember = gradient(['#7a0d05', '#c0392b', '#e67e22', '#f1c40f']);
export const brand = gradient(['#e74c3c', '#e67e22', '#f1c40f', '#7ba428']);

export const c = {
  red: chalk.hex('#e74c3c'),
  orange: chalk.hex('#e67e22'),
  gold: chalk.hex('#f1c40f'),
  green: chalk.hex('#7ba428'),
  dim: chalk.hex('#6b6b6b'),
  faint: chalk.hex('#444444'),
  white: chalk.hex('#e8e6e3'),
  box: chalk.hex('#8a2b1a'),
};

export const VERSION = '1.17.8';

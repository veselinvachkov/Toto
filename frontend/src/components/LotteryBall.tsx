interface Props {
  number: number;
  size?: 'sm' | 'md' | 'lg';
  selected?: boolean;
  pickMode?: boolean;
  onClick?: () => void;
}

function colorClass(n: number): string {
  if (n <= 10) return 'ball-red';
  if (n <= 20) return 'ball-orange';
  if (n <= 30) return 'ball-gold';
  if (n <= 40) return 'ball-green';
  return 'ball-blue';
}

export default function LotteryBall({ number, size = 'md', selected, pickMode, onClick }: Props) {
  const classes = [
    'ball',
    `ball-${size}`,
    colorClass(number),
    pickMode ? 'ball-pick' : '',
    pickMode && selected ? 'selected' : '',
    pickMode && selected === false ? 'unselected' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <span className={classes} onClick={onClick} role={onClick ? 'button' : undefined}>
      {number}
    </span>
  );
}

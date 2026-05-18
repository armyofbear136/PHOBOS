interface Props {
  content: string;
}

export function StatusPill({ content }: Props) {
  const isSuccess = content.includes('✓');
  return (
    <div className="flex justify-center py-1">
      <span
        className={`inline-flex items-center px-2.5 py-0.5 text-[11px] font-mono rounded-md ${
          isSuccess
            ? 'bg-success/10 text-success'
            : 'bg-muted text-muted-foreground'
        }`}
      >
        {content}
      </span>
    </div>
  );
}

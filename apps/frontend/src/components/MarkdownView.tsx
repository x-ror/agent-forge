import ReactMarkdown from 'react-markdown';

/** Render markdown as HTML (pretty mode). Content is treated as inert document text. */
export function MarkdownView({ source, className }: { source: string; className?: string }) {
  return (
    <div className={className ? `af-md ${className}` : 'af-md'}>
      <ReactMarkdown
        components={{
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noreferrer noopener">
              {children}
            </a>
          ),
        }}
      >
        {source}
      </ReactMarkdown>
    </div>
  );
}

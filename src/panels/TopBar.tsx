export function TopBar({ fileName, zoom }: { fileName: string; zoom: number | null }) {
  return (
    <header className="top-bar">
      <div className="file-name" data-testid="file-name">
        {fileName}
      </div>
      <div className="zoom-readout" data-testid="zoom-readout">
        {zoom === null ? '' : `${Math.round(zoom * 100)}%`}
      </div>
    </header>
  )
}

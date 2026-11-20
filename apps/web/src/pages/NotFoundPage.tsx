import { Link } from 'react-router';

export function NotFoundPage() {
  return (
    <div className="page">
      <h1>Pagina niet gevonden</h1>
      <p>
        <Link to="/">Terug naar de bibliotheken</Link>
      </p>
    </div>
  );
}

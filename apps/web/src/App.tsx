import { useCallback } from 'react';
import { Route, Routes, useNavigate } from 'react-router';
import { AuthProvider, useAuth, useAuthStatus } from './auth.js';
import { ErrorBox, Loading } from './components/common.js';
import { Layout } from './components/Layout.js';
import { AccountsPage } from './pages/AccountsPage.js';
import { AdminPage } from './pages/AdminPage.js';
import { AttentionPage } from './pages/AttentionPage.js';
import { HomePage } from './pages/HomePage.js';
import { ItemPage } from './pages/ItemPage.js';
import { LibraryPage } from './pages/LibraryPage.js';
import { MarkersPage } from './pages/MarkersPage.js';
import { LinkPage } from './pages/LinkPage.js';
import { LoginPage, SetupPage } from './pages/LoginPage.js';
import { NotFoundPage } from './pages/NotFoundPage.js';
import { PlayerPage } from './pages/PlayerPage.js';
import { ProfilePage } from './pages/ProfilePage.js';
import { SearchPage } from './pages/SearchPage.js';
import { CalendarPage } from './pages/CalendarPage.js';
import { CollectionPage } from './pages/CollectionPage.js';
import { CollectionsPage } from './pages/CollectionsPage.js';
import { MyListPage } from './pages/MyListPage.js';
import { DiscoverPage, DiscoverRowPage } from './pages/DiscoverPage.js';
import { RequestsAdminPage } from './pages/RequestsAdminPage.js';
import { RequestsPage } from './pages/RequestsPage.js';
import { useSpatialNavigation } from './spatialNav.js';

function SignedInRoutes() {
  const { isAdmin, isKid } = useAuth();
  const navigate = useNavigate();
  // Remotes and keyboards: arrows move between controls, Back goes back.
  const back = useCallback(() => {
    if (window.history.length > 1) void navigate(-1);
  }, [navigate]);
  useSpatialNavigation(back);
  return (
    <Routes>
      {/* Full screen, without header and footer. */}
      <Route path="/play/:fileId" element={<PlayerPage />} />
      <Route element={<Layout />}>
        <Route index element={<HomePage />} />
        <Route path="libraries/:id" element={<LibraryPage />} />
        <Route path="items/:id" element={<ItemPage />} />
        <Route path="search" element={<SearchPage />} />
        <Route path="my-list" element={<MyListPage />} />
        <Route path="collections" element={<CollectionsPage />} />
        <Route path="collections/:id" element={<CollectionPage />} />
        <Route path="calendar" element={<CalendarPage />} />
        {/* A kids profile can't ask for titles. */}
        {!isKid && <Route path="requests" element={<RequestsPage />} />}
        {!isKid && <Route path="discover" element={<DiscoverPage />} />}
        {!isKid && <Route path="discover/rows/:id" element={<DiscoverRowPage />} />}
        <Route path="profile" element={<ProfilePage />} />
        <Route path="link" element={<LinkPage />} />
        {isAdmin && <Route path="admin" element={<AdminPage />} />}
        {isAdmin && <Route path="admin/requests" element={<RequestsAdminPage />} />}
        {isAdmin && <Route path="admin/markers/:seasonId" element={<MarkersPage />} />}
        {isAdmin && <Route path="attention" element={<AttentionPage />} />}
        {isAdmin && <Route path="accounts" element={<AccountsPage />} />}
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}

export function App() {
  const status = useAuthStatus();
  if (status.isPending) {
    return (
      <div className="auth-page">
        <Loading />
      </div>
    );
  }
  if (status.isError) {
    return (
      <div className="auth-page">
        <ErrorBox error={status.error} />
      </div>
    );
  }
  if (status.data.setupRequired) return <SetupPage />;
  if (!status.data.user) return <LoginPage />;
  return (
    <AuthProvider user={status.data.user}>
      <SignedInRoutes />
    </AuthProvider>
  );
}

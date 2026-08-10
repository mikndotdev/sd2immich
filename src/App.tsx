import { HashRouter, Route, Routes } from "react-router";
import { Navbar } from "./components/navbar.tsx";
import { JobsProvider } from "./lib/jobs.tsx";
import Home from "./routes/index.tsx";
import Gallery from "./routes/gallery.tsx";
import SettingsPage from "./routes/settings.tsx";
import "./App.css";

function App() {
  return (
    <JobsProvider>
      <HashRouter>
        {/* pb leaves room for the fixed bottom dock */}
        <main className="min-h-screen pb-24">
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/gallery" element={<Gallery />} />
            <Route path="/settings" element={<SettingsPage />} />
          </Routes>
        </main>
        <Navbar />
      </HashRouter>
    </JobsProvider>
  );
}

export default App;

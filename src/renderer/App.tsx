import { useState } from 'react';
import { CenterAppShell } from './components/CenterAppShell';
import { ActivationGate } from './pages/ActivationGate';
import { ActiveMonitorPage } from './pages/ActiveMonitorPage';
import { Dashboard } from './pages/Dashboard';
import { ImportedExamsPage } from './pages/ImportedExamsPage';
import { ImportExamPage } from './pages/ImportExamPage';
import { ResultsExportPage } from './pages/ResultsExportPage';
import { ReadinessDrillPage } from './pages/ReadinessDrillPage';
import { SettingsPage } from './pages/SettingsPage';

export type AppPage = 'dashboard' | 'import-exam' | 'exams' | 'active-monitor' | 'results-export' | 'readiness' | 'settings';

export default function App() {
    const [page, setPage] = useState<AppPage>('dashboard');
    const [selectedExamId, setSelectedExamId] = useState<string | null>(null);

    function navigate(nextPage: AppPage) {
        if (nextPage === 'exams') {
            setSelectedExamId(null);
        }

        setPage(nextPage);
    }

    function viewExamDetails(examId: string) {
        setSelectedExamId(examId);
        setPage('exams');
    }

    function goToMonitor() {
        setPage('active-monitor');
    }

    function goToResultsExport() {
        setPage('results-export');
    }

    return (
        <ActivationGate>
            {({ logout, localAdminSessionToken }) => (
                <CenterAppShell currentPage={page} onLogout={logout} onNavigate={navigate}>
                    {page === 'import-exam' && <ImportExamPage onViewImportedExams={() => setPage('exams')} />}
                    {page === 'exams' && selectedExamId === null && <ImportedExamsPage onViewDetails={viewExamDetails} />}
                    {page === 'exams' && selectedExamId !== null && (
                        <ImportedExamsPage
                            detailExamId={selectedExamId}
                            onBackToList={() => setSelectedExamId(null)}
                            onGoToMonitor={goToMonitor}
                            onGoToResultsExport={goToResultsExport}
                            onViewDetails={viewExamDetails}
                        />
                    )}
                    {page === 'active-monitor' && <ActiveMonitorPage />}
                    {page === 'results-export' && <ResultsExportPage />}
                    {page === 'readiness' && <ReadinessDrillPage localAdminSessionToken={localAdminSessionToken} />}
                    {page === 'settings' && <SettingsPage />}
                    {page !== 'import-exam' && page !== 'exams' && page !== 'active-monitor' && page !== 'results-export' && page !== 'readiness' && page !== 'settings' && <Dashboard />}
                </CenterAppShell>
            )}
        </ActivationGate>
    );
}

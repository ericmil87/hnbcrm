import { Authenticated, Unauthenticated, useQuery } from "convex/react";
import { api } from "../convex/_generated/api";
import { Id } from "../convex/_generated/dataModel";
import { SignInForm } from "./SignInForm";
import { SignOutButton } from "./SignOutButton";
import { Toaster } from "sonner";
import { useState } from "react";
import { Dashboard } from "./components/Dashboard";
import { OrganizationSelector } from "./components/OrganizationSelector";

export default function App() {
  const [selectedOrgId, setSelectedOrgId] = useState<Id<"organizations"> | null>(null);

  return (
    <div className="min-h-screen flex flex-col bg-gray-50">
      <header className="sticky top-0 z-10 bg-white/80 backdrop-blur-sm h-16 flex justify-between items-center border-b shadow-sm px-4">
        <div className="flex items-center gap-4">
          <h2 className="text-xl font-semibold text-blue-600">ClawCRM</h2>
          <Authenticated>
            <OrganizationSelector 
              selectedOrgId={selectedOrgId} 
              onSelectOrg={setSelectedOrgId} 
            />
          </Authenticated>
        </div>
        <SignOutButton />
      </header>
      <main className="flex-1">
        <Content selectedOrgId={selectedOrgId} />
      </main>
      <Toaster />
    </div>
  );
}

function Content({ selectedOrgId }: { selectedOrgId: Id<"organizations"> | null }) {
  const loggedInUser = useQuery(api.auth.loggedInUser);

  if (loggedInUser === undefined) {
    return (
      <div className="flex justify-center items-center h-96">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
      </div>
    );
  }

  return (
    <div className="flex flex-col">
      <Authenticated>
        {selectedOrgId ? (
          <Dashboard organizationId={selectedOrgId} />
        ) : (
          <div className="flex items-center justify-center h-96">
            <div className="text-center">
              <h1 className="text-2xl font-bold text-gray-900 mb-4">Welcome to ClawCRM</h1>
              <p className="text-gray-600">Select an organization to get started</p>
            </div>
          </div>
        )}
      </Authenticated>
      
      <Unauthenticated>
        <div className="flex items-center justify-center min-h-[80vh]">
          <div className="w-full max-w-md mx-auto p-8">
            <div className="text-center mb-8">
              <h1 className="text-4xl font-bold text-blue-600 mb-4">ClawCRM</h1>
              <p className="text-xl text-gray-600">Multi-tenant CRM with AI collaboration</p>
            </div>
            <SignInForm />
          </div>
        </div>
      </Unauthenticated>
    </div>
  );
}

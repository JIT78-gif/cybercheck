"use client";

import { useState } from "react";
import { Plus } from "lucide-react";
import { AddProjectDialog } from "@/components/intake/add-project";
import { useAddFromQuery } from "@/components/intake/use-add-from-query";
import { Button } from "@/components/ui/button";
import { useAppData } from "./app-data";
import { ProjectsTable } from "./projects-table";
import { Card, PageHeader } from "./ui";

export function ProjectsPage() {
  const { projects } = useAppData();
  const [adding, setAdding] = useState(false);
  const { fromGithub, clear } = useAddFromQuery();
  return (
    <div className="space-y-6">
      <PageHeader
        section="Projects"
        title="Projects"
        actions={
          <Button shape="pill" onClick={() => setAdding(true)}>
            <Plus aria-hidden="true" /> Add project
          </Button>
        }
      />
      <Card>
        <ProjectsTable projects={projects} onAdd={() => setAdding(true)} />
      </Card>
      <AddProjectDialog
        open={adding || fromGithub}
        initialSource={fromGithub ? "github" : undefined}
        onClose={() => {
          setAdding(false);
          clear();
        }}
      />
    </div>
  );
}

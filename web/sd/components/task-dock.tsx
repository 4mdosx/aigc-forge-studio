'use client'

import { ListTodo, X } from 'lucide-react'

import { TaskDetail } from '@/components/task-detail'
import type { Task } from '@/lib/types'

export function TaskDock({
  tasks,
  open,
  selectedId,
  onToggle,
  onSelect,
}: {
  tasks: Task[]
  open: boolean
  selectedId: string | null
  onToggle: () => void
  onSelect: (id: string) => void
}) {
  const running = tasks.some((task) => task.status === 'running')
  return (
    <>
      <button
        type="button"
        className={open ? 'count-fab pressed' : 'count-fab'}
        aria-expanded={open}
        aria-label={`进行中的任务 ${tasks.length}`}
        title="进行中"
        onClick={onToggle}
      >
        <ListTodo size={16} />
        <span>{tasks.length}</span>
        {running ? <span className="live-dot" aria-hidden="true" /> : null}
      </button>
      {open ? (
        <section className="float-panel task-panel" aria-label="进行中的任务">
          <div className="column-head">
            <h2>进行中</h2>
            <button type="button" className="quiet icon" aria-label="关闭" title="关闭" onClick={onToggle}>
              <X size={16} />
            </button>
          </div>
          <div className="task-split">
            <div className="task-picks">
              {tasks.length === 0 ? (
                <p className="muted">没有正在进行的任务。</p>
              ) : (
                <ul className="stack">
                  {tasks.map((task) => (
                    <li key={task.id}>
                      <button
                        type="button"
                        className={task.id === selectedId ? 'task-pick current' : 'task-pick'}
                        onClick={() => onSelect(task.id)}
                      >
                        <span>{task.task}</span>
                        <span className={`status ${task.status}`}>{task.status}</span>
                        <span className="muted">
                          {[task.workName, task.workflowName].filter(Boolean).join(' · ')}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div className="task-detail-pane">
              {selectedId ? (
                <TaskDetail id={selectedId} embedded />
              ) : tasks.length > 0 ? (
                <p className="muted">选择一个任务查看详情。</p>
              ) : null}
            </div>
          </div>
        </section>
      ) : null}
    </>
  )
}

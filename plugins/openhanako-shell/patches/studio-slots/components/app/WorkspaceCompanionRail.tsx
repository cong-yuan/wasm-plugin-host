import { useStore } from '../../stores';
import { RegionalErrorBoundary } from '../RegionalErrorBoundary';
import { RightWorkspacePanel } from '../right-workspace/RightWorkspacePanel';
import { WorkspaceFileChangeBridge } from './WorkspaceFileChangeBridge';

export function WorkspaceCompanionRail() {
  const jianOpen = useStore(s => s.jianOpen);

  return (
    <>
      <WorkspaceFileChangeBridge />
      <aside className={`jian-sidebar${jianOpen ? '' : ' collapsed'}`} id="jianSidebar">
        <div className="resize-handle resize-handle-left" id="jianResizeHandle"></div>
        <div
          data-ohk-slot="openhanako.rail.header"
          className="ohk-slot-anchor ohk-slot-rail-header"
        />
        <div className="jian-sidebar-inner" data-ohk-slot="openhanako.rail.items">
          <RegionalErrorBoundary region="right-workspace">
            <RightWorkspacePanel />
          </RegionalErrorBoundary>
        </div>
      </aside>
    </>
  );
}

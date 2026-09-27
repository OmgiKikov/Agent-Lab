// Additive launcher for this local project's server-served review extension.
// Runs in the existing LangWatch shell; no credentials or page data are read.
let localReviewEntry;
function updateLocalReviewEntry(){
  const belongs=location.pathname.startsWith('/local-dev-project-se7hbx')&&!location.pathname.endsWith('.html');
  if(!belongs){localReviewEntry?.remove();localReviewEntry=null;return;}
  if(localReviewEntry?.isConnected)return;
  localReviewEntry=document.createElement('a');
  localReviewEntry.href='/agent-review.html';localReviewEntry.textContent='Проверка логов →';
  localReviewEntry.setAttribute('aria-label','Проверка логов и карточки агента');
  Object.assign(localReviewEntry.style,{position:'fixed',right:'24px',bottom:'22px',zIndex:'1100',background:'#267352',color:'#fff',
    padding:'12px 19px',borderRadius:'9px',fontSize:'14px',fontWeight:'600',textDecoration:'none',boxShadow:'0 4px 20px #163b2820'});
  document.body.append(localReviewEntry);
}
updateLocalReviewEntry();setInterval(updateLocalReviewEntry,1000);

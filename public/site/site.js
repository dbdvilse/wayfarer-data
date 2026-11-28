(function(){var q=document.getElementById('q'),f=document.getElementById('fam');if(!q)return;
var rows=[].slice.call(document.querySelectorAll('tbody tr'));
function run(){var t=q.value.trim().toLowerCase(),k=f.value;rows.forEach(function(r){r.style.display=(r.dataset.name.indexOf(t)>-1&&(!k||r.dataset.fam===k))?'':'none';});}
q.addEventListener('input',run);f.addEventListener('change',run);})();

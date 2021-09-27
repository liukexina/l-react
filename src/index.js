import * as React from 'react';
import * as ReactDOM from 'react-dom';
import SchedulerTask from "./SchedulerTask"
import SchedulerState from "./SchedulerTask/state"
import schedulerTest from './Scheduler/index'
import reportWebVitals from './reportWebVitals';
import './index.css';

// ReactDOM.render(
//   <React.StrictMode>
//     <App />
//   </React.StrictMode>,
//   document.getElementById('root')
// );

function App() {
  // schedulerTest();
  return <SchedulerState />
}

ReactDOM.unstable_createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

// ReactDOM.createRoot(root).render(<App />);

// If you want to start measuring performance in your app, pass a function
// to log results (for example: reportWebVitals(console.log))
// or send to an analytics endpoint. Learn more: https://bit.ly/CRA-vitals
reportWebVitals();

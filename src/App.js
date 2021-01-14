import { React }  from './adaptation';
import logo from './logo.svg';
import './App.css';

class App extends React.Component{
  constructor(props) {
    super(props);
    this.state = {number: 1};
  }

  add = () => {
    this.setState({
      number: this.state.number + 1
    })
  }

  render() {
    return (
      <div className="App">
        <header className="App-header">
          <img src={logo} className="App-logo" alt="logo" />
          <p>
            Edit <code>src/App.js</code> and save to reload.
          </p>
          <a
            className="App-link"
            href="https://reactjs.org"
            target="_blank"
            onClick={() => {}}
            rel="noopener noreferrer"
          >
            Learn React
          </a>
          <button onClick={this.add}>{this.state.number}</button>
        </header>
      </div>
    );
  }
}

export default App;
